import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';

@Injectable()
export class SupabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject('SUPABASE_DATABASE_POOL') pool?: Pool,
  ) {
    const connectionString = this.getRequiredConfig('DATABASE_URL');
    const poolConnectionString = connectionString.replace(
      /([?&])sslmode=require(?=(&|$))/i,
      '$1sslmode=no-verify',
    );

    this.pool =
      pool ??
      new Pool({
        connectionString: poolConnectionString,
        max: 1,
      });
  }

  async getEmployees(limit: number, offset: number) {
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    if (offset < 0) {
      throw new BadRequestException('offset must be zero or greater');
    }

    const table =
      this.configService.get<string>('SUPABASE_TABLE') ?? 'employees';

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new InternalServerErrorException(
        'SUPABASE_TABLE must be a valid table name',
      );
    }

    try {
      const result = await this.pool.query(
        `WITH paged_employees AS (
           SELECT *
           FROM "${table}"
           ORDER BY created_at, id
           LIMIT $1 OFFSET $2
         )
         SELECT
           employee.*,
           summary.attendance_summary
         FROM paged_employees AS employee
         CROSS JOIN LATERAL (
           SELECT jsonb_build_object(
             'total_absent',
             COUNT(*) FILTER (WHERE attendance.effective_status = 'ABSENT')::int,
             'total_half_days',
             COUNT(*) FILTER (WHERE attendance.effective_status = 'HALF_DAY')::int,
             'absent_days',
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'id', attendance.id,
                   'date', attendance.date,
                   'status', attendance.status,
                   'status_override', attendance.status_override,
                   'effective_status', attendance.effective_status,
                   'first_check_in', attendance.first_check_in,
                   'last_check_out', attendance.last_check_out,
                   'working_minutes', attendance.working_minutes,
                   'shift_id', attendance.shift_id,
                   'shift_name', attendance.shift_name_snapshot
                 ) ORDER BY attendance.date
               ) FILTER (WHERE attendance.effective_status = 'ABSENT'),
               '[]'::jsonb
             ),
             'half_days',
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'id', attendance.id,
                   'date', attendance.date,
                   'status', attendance.status,
                   'status_override', attendance.status_override,
                   'effective_status', attendance.effective_status,
                   'first_check_in', attendance.first_check_in,
                   'last_check_out', attendance.last_check_out,
                   'working_minutes', attendance.working_minutes,
                   'shift_id', attendance.shift_id,
                   'shift_name', attendance.shift_name_snapshot
                 ) ORDER BY attendance.date
               ) FILTER (WHERE attendance.effective_status = 'HALF_DAY'),
               '[]'::jsonb
             )
           ) AS attendance_summary
           FROM (
             SELECT
               daily.*,
               COALESCE(daily.status_override, daily.status) AS effective_status
             FROM daily_attendance AS daily
             WHERE daily.employee_id = employee.id
           ) AS attendance
         ) AS summary
         ORDER BY employee.created_at, employee.id`,
        [limit, offset],
      );

      return {
        data: result.rows,
        pagination: {
          limit,
          offset,
          count: result.rows.length,
        },
      };
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async findEmployeeCredential(identity: string) {
    const identifier = identity.trim();

    if (!identifier) {
      throw new BadRequestException('identity must not be empty');
    }

    try {
      const result = await this.pool.query<{
        id: string;
        employee_code: string;
        name: string;
        is_active: boolean;
        password_hash: string;
        email: string | null;
      }>(
        `SELECT
           employee.id,
           employee.employee_code,
           employee.name,
           employee.is_active,
           portal_user.password_hash,
           portal_user.email
         FROM employees AS employee
         LEFT JOIN users AS portal_user
           ON portal_user.employee_id = employee.id
         WHERE employee.id::text = $1
            OR employee.employee_code = $1
            OR LOWER(portal_user.email) = LOWER($1)
         LIMIT 1`,
        [identifier],
      );

      const row = result.rows[0];
      if (!row || !row.password_hash) {
        return null;
      }

      return {
        id: row.id,
        employeeCode: row.employee_code,
        name: row.name,
        email: row.email,
        isActive: row.is_active,
        passwordHash: row.password_hash,
      };
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async getPayrollDeduction(
    employeeId: string,
    cycleKey?: string,
  ): Promise<{
    cycle: string;
    lateDays: number;
    halfDays: number;
    absentDays: number;
    lateHalfDayDeductionDays: number;
    totalDeductionDays: number;
    monthlySalary: number;
    payrollDays: number;
    dailyRate: number;
    deductionAmount: number;
    allowanceAmount: number;
    calculatedThrough: string | null;
  } | null> {
    const identifier = employeeId.trim();
    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }

    const normalizedCycleKey = cycleKey?.trim();
    if (
      cycleKey !== undefined &&
      (!normalizedCycleKey ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(normalizedCycleKey))
    ) {
      throw new BadRequestException(
        'cycle must be a YYYY-MM payroll cycle key',
      );
    }

    try {
      const employeeResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM employees
         WHERE id::text = $1 OR employee_code = $1
         LIMIT 1`,
        [identifier],
      );
      const employeePk = employeeResult.rows[0]?.id;
      if (!employeePk) return null;

      const cycleFilter = normalizedCycleKey
        ? ' AND d.payroll_cycle_month = $2'
        : '';
      const result = await this.pool.query<{
        payroll_cycle_month: string;
        late_days: number;
        half_days: number;
        absent_days: number;
        late_half_day_deduction_days: number;
        total_deduction_days: number;
        monthly_salary: string;
        employee_monthly_salary: string | null;
        employee_allowance: string | null;
        payroll_days: number;
        daily_rate: string;
        deduction_amount: string;
        calculated_through: string | null;
      }>(
        `SELECT
           d.payroll_cycle_month,
           d.late_days,
           d.half_days,
           d.absent_days,
           d.late_half_day_deduction_days,
           d.total_deduction_days,
           d.monthly_salary::text AS monthly_salary,
           e.monthly_salary::text AS employee_monthly_salary,
           e.allowance::text AS employee_allowance,
           d.payroll_days,
           d.daily_rate::text AS daily_rate,
           d.deduction_amount::text AS deduction_amount,
           d.calculated_through
         FROM public.deductions d
         JOIN public.employees e ON e.id = d.employee_id
         WHERE d.employee_id = $1
           ${cycleFilter}
         ORDER BY d.payroll_cycle_month DESC, d.updated_at DESC
         LIMIT 1`,
        normalizedCycleKey ? [employeePk, normalizedCycleKey] : [employeePk],
      );

      const row = result.rows[0];
      if (!row) return null;

      const monthlySalary =
        row.monthly_salary !== null && Number(row.monthly_salary) > 0
          ? Number(row.monthly_salary)
          : row.employee_monthly_salary !== null
            ? Number(row.employee_monthly_salary)
            : 0;
      const dailyRate =
        monthlySalary > 0 && row.payroll_days > 0
          ? Math.round((monthlySalary / row.payroll_days) * 100) / 100
          : Number(row.daily_rate);
      const deductionAmount = Math.max(
        0,
        Number(row.deduction_amount) || 0,
      );
      const allowanceAmount =
        row.total_deduction_days >= 1
          ? Math.max(0, Number(row.employee_allowance) || 0)
          : 0;

      return {
        cycle: row.payroll_cycle_month,
        lateDays: row.late_days,
        halfDays: row.half_days,
        absentDays: row.absent_days,
        lateHalfDayDeductionDays: row.late_half_day_deduction_days,
        totalDeductionDays: row.total_deduction_days,
        monthlySalary,
        payrollDays: row.payroll_days,
        dailyRate,
        deductionAmount,
        allowanceAmount,
        calculatedThrough: row.calculated_through,
      };
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async getEmployeePortal(employeeId: string) {
    const identifier = employeeId.trim();

    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }

    try {
      const employeeResult = await this.pool.query<{
        id: string;
        employee_code: string;
        name: string;
        is_active: boolean;
        monthly_salary: string;
        allowance: string | null;
        created_at: Date;
        department: string | null;
        organization: string;
        timezone: string;
        shift_name: string | null;
        email: string | null;
      }>(
        `SELECT
           employee.id,
           employee.employee_code,
           employee.name,
           employee.is_active,
           employee.monthly_salary,
           employee.allowance,
           employee.created_at,
           department.name AS department,
           organization.name AS organization,
           organization.timezone,
           active_shift.name AS shift_name,
           portal_user.email
         FROM employees AS employee
         JOIN organizations AS organization
           ON organization.id = employee.organization_id
         LEFT JOIN departments AS department
           ON department.id = employee.department_id
         LEFT JOIN users AS portal_user
           ON portal_user.employee_id = employee.id
         LEFT JOIN LATERAL (
           SELECT shift.name
           FROM employee_shift_assignments AS assignment
           JOIN shifts AS shift ON shift.id = assignment.shift_id
           WHERE assignment.employee_id = employee.id
             AND assignment.effective_from <= CURRENT_DATE
             AND (
               assignment.effective_to IS NULL
               OR assignment.effective_to >= CURRENT_DATE
             )
           ORDER BY assignment.effective_from DESC
           LIMIT 1
         ) AS active_shift ON TRUE
         WHERE employee.id::text = $1
            OR employee.employee_code = $1
            OR LOWER(portal_user.email) = LOWER($1)
         LIMIT 1`,
        [identifier],
      );
      const employee = employeeResult.rows[0];

      if (!employee) {
        return null;
      }

      const attendanceResult = await this.pool.query<{
        id: string;
        date: string;
        first_check_in: Date | null;
        last_check_out: Date | null;
        working_minutes: number;
        effective_status: string;
        shift_name: string | null;
        scheduled_start: Date | null;
        scheduled_end: Date | null;
        grace_deadline: Date | null;
      }>(
        `SELECT
           attendance.id,
           attendance.date::text AS date,
           attendance.first_check_in,
           attendance.last_check_out,
           attendance.working_minutes,
           COALESCE(attendance.status_override, attendance.status)::text
             AS effective_status,
           attendance.shift_name_snapshot AS shift_name,
           attendance.scheduled_start,
           attendance.scheduled_end,
           attendance.grace_deadline
         FROM daily_attendance AS attendance
         WHERE attendance.employee_id = $1
         ORDER BY attendance.date DESC
         LIMIT 366`,
        [employee.id],
      );

      return {
        employee: {
          id: employee.id,
          employeeCode: employee.employee_code,
          name: employee.name,
          email: employee.email,
          isActive: employee.is_active,
          monthlySalary: Number(employee.monthly_salary),
          allowance: Math.max(0, Number(employee.allowance) || 0),
          joinedAt: employee.created_at,
          department: employee.department,
          organization: employee.organization,
          timeZone: employee.timezone,
          shiftName: employee.shift_name,
        },
        attendance: attendanceResult.rows.map((attendance) => ({
          id: attendance.id,
          date: attendance.date,
          firstCheckIn: attendance.first_check_in,
          lastCheckOut: attendance.last_check_out,
          workingMinutes: attendance.working_minutes,
          status: attendance.effective_status,
          shiftName: attendance.shift_name,
          scheduledStart: attendance.scheduled_start,
          scheduledEnd: attendance.scheduled_end,
          graceDeadline: attendance.grace_deadline,
        })),
      };
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async getDatabaseData(limit: number, offset: number, employeeId?: string) {
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    if (offset < 0) {
      throw new BadRequestException('offset must be zero or greater');
    }

    const normalizedEmployeeId = employeeId?.trim();

    if (employeeId !== undefined && !normalizedEmployeeId) {
      throw new BadRequestException('employeeId must not be empty');
    }

    try {
      const tables = await this.pool.query<{
        table_schema: string;
        table_name: string;
        has_employee_id: boolean;
        has_id: boolean;
        has_employee_code: boolean;
      }>(`
        SELECT
          tables.table_schema,
          tables.table_name,
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = tables.table_schema
              AND table_name = tables.table_name
              AND column_name = 'employee_id'
          ) AS has_employee_id,
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = tables.table_schema
              AND table_name = tables.table_name
              AND column_name = 'id'
          ) AS has_id
          , EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = tables.table_schema
              AND table_name = tables.table_name
              AND column_name = 'employee_code'
          ) AS has_employee_code
        FROM information_schema.tables
          AS tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_schema NOT LIKE 'pg_toast%'
        ORDER BY table_schema, table_name
      `);

      const data: Record<string, QueryResultRow[]> = {};
      const pagination: Record<
        string,
        { limit: number; offset: number; count: number; total: number }
      > = {};
      const employeeTable =
        this.configService.get<string>('SUPABASE_TABLE') ?? 'employees';
      let resolvedEmployeeId = normalizedEmployeeId;

      if (normalizedEmployeeId) {
        const employeeTableInfo = tables.rows.find(
          (table) =>
            table.table_name === employeeTable &&
            table.has_id &&
            table.has_employee_code,
        );

        if (!employeeTableInfo) {
          return { data: {}, tables: [], pagination: {} };
        }

        const employeeTableName = `${this.quoteIdentifier(employeeTableInfo.table_schema)}.${this.quoteIdentifier(employeeTableInfo.table_name)}`;
        const employeeResult = await this.pool.query<{ id: string }>(
          `SELECT ${this.quoteIdentifier('id')}::text AS id FROM ${employeeTableName} WHERE ${this.quoteIdentifier('id')}::text = $1 OR ${this.quoteIdentifier('employee_code')} = $1 LIMIT 1`,
          [normalizedEmployeeId],
        );

        resolvedEmployeeId = employeeResult.rows[0]?.id;

        if (!resolvedEmployeeId) {
          return { data: {}, tables: [], pagination: {} };
        }
      }

      for (const table of tables.rows) {
        const filterColumn = normalizedEmployeeId
          ? table.table_name === employeeTable && table.has_id
            ? 'id'
            : table.has_employee_id
              ? 'employee_id'
              : undefined
          : undefined;

        if (normalizedEmployeeId && !filterColumn) {
          continue;
        }

        const tableKey = `${table.table_schema}.${table.table_name}`;
        const qualifiedTable = `${this.quoteIdentifier(table.table_schema)}.${this.quoteIdentifier(table.table_name)}`;
        const whereClause = filterColumn
          ? ` WHERE ${this.quoteIdentifier(filterColumn)} = $1`
          : '';
        const countResult = await this.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${qualifiedTable}${whereClause}`,
          filterColumn ? [resolvedEmployeeId] : undefined,
        );
        data[tableKey] = (
          await this.pool.query<QueryResultRow>(
            `SELECT * FROM ${qualifiedTable}${whereClause} LIMIT $${
              filterColumn ? 2 : 1
            } OFFSET $${filterColumn ? 3 : 2}`,
            filterColumn
              ? [resolvedEmployeeId, limit, offset]
              : [limit, offset],
          )
        ).rows;
        pagination[tableKey] = {
          limit,
          offset,
          count: data[tableKey].length,
          total: Number(countResult.rows[0]?.count ?? 0),
        };
      }

      return {
        data,
        tables: Object.keys(data),
        pagination,
      };
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async listRequests(employeeId: string) {
    const identifier = employeeId.trim();
    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }

    try {
      const employeeResult = await this.pool.query<{ id: string }>(
        `SELECT id::text AS id
         FROM employees
         WHERE id::text = $1 OR employee_code = $1
         LIMIT 1`,
        [identifier],
      );
      const employeePk = employeeResult.rows[0]?.id;
      if (!employeePk) return [];

      const result = await this.pool.query<{
        id: string;
        kind: string;
        leave_category: string | null;
        from_date: string;
        to_date: string;
        reason: string;
        note: string | null;
        status: string;
        submitted_at: Date;
        decided_at: Date | null;
      }>(
        `SELECT
           id,
           kind::text AS kind,
           leave_category::text AS leave_category,
           from_date::text AS from_date,
           to_date::text AS to_date,
           reason,
           note,
           status::text AS status,
           submitted_at,
           decided_at
         FROM employee_requests
         WHERE employee_id = $1
         ORDER BY submitted_at DESC
         LIMIT 200`,
        [employeePk],
      );

      const rows = result.rows;
      if (rows.length === 0) return [];

      const attachmentsResult = await this.pool.query<{
        id: string;
        request_id: string;
        original_name: string;
        mime_type: string;
        size_bytes: string;
        uploaded_at: Date;
        expires_at: Date;
      }>(
        `SELECT id, request_id, original_name, mime_type, size_bytes, uploaded_at, expires_at
         FROM request_attachments
         WHERE employee_id = $1
           AND request_id = ANY($2::uuid[])`,
        [employeePk, rows.map((row) => row.id)],
      );

      const grouped = new Map<
        string,
        Array<{
          id: string;
          originalName: string;
          mimeType: string;
          sizeBytes: number;
          uploadedAt: Date;
          expiresAt: Date;
        }>
      >();
      for (const att of attachmentsResult.rows) {
        const list = grouped.get(att.request_id) ?? [];
        list.push({
          id: att.id,
          originalName: att.original_name,
          mimeType: att.mime_type,
          sizeBytes: Number(att.size_bytes),
          uploadedAt: att.uploaded_at,
          expiresAt: att.expires_at,
        });
        grouped.set(att.request_id, list);
      }

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        leaveCategory: row.leave_category,
        fromDate: row.from_date,
        toDate: row.to_date,
        reason: row.reason,
        note: row.note,
        status: row.status,
        submittedAt: row.submitted_at,
        decidedAt: row.decided_at,
        attachments: grouped.get(row.id) ?? [],
      }));
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async createRequest(
    employeeId: string,
    payload: {
      kind: 'LEAVE' | 'REMOTE_WORK';
      leaveCategory?:
        'ANNUAL_LEAVE' | 'SICK_LEAVE' | 'CASUAL_LEAVE' | 'UNPAID_LEAVE';
      fromDate: string;
      toDate: string;
      reason: string;
      note?: string | null;
    },
  ) {
    const identifier = employeeId.trim();
    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }

    if (!payload.fromDate || !payload.toDate) {
      throw new BadRequestException('fromDate and toDate are required');
    }
    if (payload.fromDate > payload.toDate) {
      throw new BadRequestException('fromDate must be on or before toDate');
    }
    if (!payload.reason.trim()) {
      throw new BadRequestException('reason is required');
    }
    if (payload.kind === 'LEAVE' && !payload.leaveCategory) {
      throw new BadRequestException(
        'leaveCategory is required for leave requests',
      );
    }

    try {
      const employeeResult = await this.pool.query<{
        id: string;
        organization_id: string;
        is_active: boolean;
      }>(
        `SELECT id, organization_id, is_active
         FROM employees
         WHERE id::text = $1 OR employee_code = $1
         LIMIT 1`,
        [identifier],
      );
      const employee = employeeResult.rows[0];
      if (!employee) {
        throw new BadRequestException('No employee matches those details.');
      }
      if (!employee.is_active) {
        throw new BadRequestException('Employee account is inactive.');
      }

      const insert = await this.pool.query<{
        id: string;
        submitted_at: Date;
      }>(
        `INSERT INTO employee_requests (
           organization_id,
           employee_id,
           kind,
           leave_category,
           from_date,
           to_date,
           reason,
           note
         ) VALUES ($1, $2, $3::"RequestKind", $4::"LeaveCategory", $5::date, $6::date, $7, $8)
         RETURNING id, submitted_at`,
        [
          employee.organization_id,
          employee.id,
          payload.kind,
          payload.kind === 'LEAVE' ? payload.leaveCategory : null,
          payload.fromDate,
          payload.toDate,
          payload.reason.trim(),
          payload.note?.trim() || null,
        ],
      );

      return {
        id: insert.rows[0].id,
        submittedAt: insert.rows[0].submitted_at,
        organizationId: employee.organization_id,
        employeeId: employee.id,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException('Database request failed');
    }
  }

  async deletePendingRequest(employeeId: string, requestId: string) {
    const identifier = employeeId.trim();
    const targetId = requestId.trim();

    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }
    if (!targetId) {
      throw new BadRequestException('requestId must not be empty');
    }

    try {
      const employeeResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM employees
         WHERE id::text = $1 OR employee_code = $1
         LIMIT 1`,
        [identifier],
      );
      const employeePk = employeeResult.rows[0]?.id;
      if (!employeePk) {
        throw new NotFoundException('Request not found.');
      }

      const attachments = await this.pool.query<{ storage_path: string }>(
        `DELETE FROM request_attachments
         WHERE request_id = $1 AND employee_id = $2
         RETURNING storage_path`,
        [targetId, employeePk],
      );

      const result = await this.pool.query<{ status: string }>(
        `DELETE FROM employee_requests
         WHERE id = $1
           AND employee_id = $2
           AND status = 'PENDING'
         RETURNING status::text AS status`,
        [targetId, employeePk],
      );

      if (result.rowCount === 0 && attachments.rowCount === 0) {
        throw new NotFoundException('Pending request not found.');
      }

      return attachments.rows.map((row) => ({
        storagePath: row.storage_path,
      }));
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      throw new BadGatewayException('Database request failed');
    }
  }

  async listCorrections(employeeId: string) {
    const identifier = employeeId.trim();
    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }

    try {
      const employeeResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM employees
         WHERE id::text = $1 OR employee_code = $1
         LIMIT 1`,
        [identifier],
      );
      const employeePk = employeeResult.rows[0]?.id;
      if (!employeePk) return [];

      const result = await this.pool.query<{
        id: string;
        daily_attendance_id: string | null;
        complaint_type: string;
        expected_check_in: string | null;
        expected_check_out: string | null;
        description: string;
        status: string;
        submitted_at: Date;
        decided_at: Date | null;
        attendance_date: string | null;
      }>(
        `SELECT
           c.id,
           c.daily_attendance_id,
           c.complaint_type::text AS complaint_type,
           c.expected_check_in::text AS expected_check_in,
           c.expected_check_out::text AS expected_check_out,
           c.description,
           c.status::text AS status,
           c.submitted_at,
           c.decided_at,
           att.date::text AS attendance_date
         FROM attendance_corrections c
         LEFT JOIN daily_attendance att ON att.id = c.daily_attendance_id
         WHERE c.employee_id = $1
         ORDER BY c.submitted_at DESC
         LIMIT 200`,
        [employeePk],
      );

      return result.rows.map((row) => ({
        id: row.id,
        dailyAttendanceId: row.daily_attendance_id,
        complaintType: row.complaint_type,
        expectedCheckIn: row.expected_check_in,
        expectedCheckOut: row.expected_check_out,
        description: row.description,
        status: row.status,
        submittedAt: row.submitted_at,
        decidedAt: row.decided_at,
        attendanceDate: row.attendance_date,
      }));
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async createCorrection(
    employeeId: string,
    payload: {
      dailyAttendanceId?: string | null;
      complaintType:
        | 'INCORRECT_CHECK_IN'
        | 'INCORRECT_CHECK_OUT'
        | 'INCORRECT_STATUS'
        | 'MISSING_ATTENDANCE'
        | 'OTHER';
      expectedCheckIn?: string | null;
      expectedCheckOut?: string | null;
      description: string;
    },
  ) {
    const identifier = employeeId.trim();
    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }
    if (!payload.description.trim()) {
      throw new BadRequestException('description is required');
    }

    try {
      const employeeResult = await this.pool.query<{
        id: string;
        organization_id: string;
        is_active: boolean;
      }>(
        `SELECT id, organization_id, is_active
         FROM employees
         WHERE id::text = $1 OR employee_code = $1
         LIMIT 1`,
        [identifier],
      );
      const employee = employeeResult.rows[0];
      if (!employee) {
        throw new BadRequestException('No employee matches those details.');
      }
      if (!employee.is_active) {
        throw new BadRequestException('Employee account is inactive.');
      }

      const dailyId = payload.dailyAttendanceId?.trim() || null;
      if (dailyId) {
        const ownership = await this.pool.query<{ employee_id: string }>(
          `SELECT employee_id::text AS employee_id
           FROM daily_attendance
           WHERE id::text = $1
           LIMIT 1`,
          [dailyId],
        );
        const owner = ownership.rows[0]?.employee_id;
        if (!owner) {
          throw new BadRequestException(
            'The selected attendance record could not be found.',
          );
        }
        if (owner !== employee.id) {
          throw new BadRequestException(
            'The selected attendance record does not belong to this employee.',
          );
        }
      }

      const insert = await this.pool.query<{
        id: string;
        submitted_at: Date;
      }>(
        `INSERT INTO attendance_corrections (
           organization_id,
           employee_id,
           daily_attendance_id,
           complaint_type,
           expected_check_in,
           expected_check_out,
           description
         ) VALUES (
           $1, $2, $3, $4::"ComplaintType",
           $5::time, $6::time, $7
         )
         RETURNING id, submitted_at`,
        [
          employee.organization_id,
          employee.id,
          dailyId,
          payload.complaintType,
          payload.expectedCheckIn?.trim() || null,
          payload.expectedCheckOut?.trim() || null,
          payload.description.trim(),
        ],
      );

      return {
        id: insert.rows[0].id,
        submittedAt: insert.rows[0].submitted_at,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException('Database request failed');
    }
  }

  async deletePendingCorrection(employeeId: string, correctionId: string) {
    const identifier = employeeId.trim();
    const targetId = correctionId.trim();

    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }
    if (!targetId) {
      throw new BadRequestException('correctionId must not be empty');
    }

    try {
      const employeeResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM employees
         WHERE id::text = $1 OR employee_code = $1
         LIMIT 1`,
        [identifier],
      );
      const employeePk = employeeResult.rows[0]?.id;
      if (!employeePk) {
        throw new NotFoundException('Correction not found.');
      }

      const result = await this.pool.query<{ status: string }>(
        `DELETE FROM attendance_corrections
         WHERE id = $1
           AND employee_id = $2
           AND status = 'PENDING'
         RETURNING status::text AS status`,
        [targetId, employeePk],
      );

      if (result.rowCount === 0) {
        throw new NotFoundException('Pending correction not found.');
      }
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      throw new BadGatewayException('Database request failed');
    }
  }

  private getRequiredConfig(name: string): string {
    const value = this.configService.get<string>(name);

    if (!value) {
      throw new InternalServerErrorException(`${name} is not configured`);
    }

    return value;
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  async createRequestAttachments(args: {
    requestId: string;
    organizationId: string;
    employeeId: string;
    expiresAt: Date;
    files: Array<{
      originalName: string;
      storedName: string;
      mimeType: string;
      sizeBytes: number;
      storagePath: string;
    }>;
  }) {
    if (args.files.length === 0) return [];
    try {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      args.files.forEach((file, index) => {
        const base = index * 8;
        placeholders.push(
          `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::bigint, $${base + 8}, $${base + 9}::timestamptz)`,
        );
        values.push(
          args.requestId,
          args.organizationId,
          args.employeeId,
          file.originalName,
          file.storedName,
          file.mimeType,
          file.sizeBytes,
          file.storagePath,
          args.expiresAt,
        );
      });
      const result = await this.pool.query<{
        id: string;
        original_name: string;
        stored_name: string;
        mime_type: string;
        size_bytes: string;
        uploaded_at: Date;
        expires_at: Date;
      }>(
        `INSERT INTO request_attachments
           (request_id, organization_id, employee_id, original_name, stored_name, mime_type, size_bytes, storage_path, expires_at)
         VALUES ${placeholders.join(', ')}
         RETURNING id, original_name, stored_name, mime_type, size_bytes, uploaded_at, expires_at`,
        values,
      );
      return result.rows.map((row) => ({
        id: row.id,
        originalName: row.original_name,
        storedName: row.stored_name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        uploadedAt: row.uploaded_at,
        expiresAt: row.expires_at,
      }));
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async listRequestAttachments(requestId: string) {
    try {
      const result = await this.pool.query<{
        id: string;
        original_name: string;
        stored_name: string;
        mime_type: string;
        size_bytes: string;
        uploaded_at: Date;
        expires_at: Date;
      }>(
        `SELECT id, original_name, stored_name, mime_type, size_bytes, uploaded_at, expires_at
         FROM request_attachments
         WHERE request_id = $1
         ORDER BY uploaded_at ASC`,
        [requestId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        originalName: row.original_name,
        storedName: row.stored_name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        uploadedAt: row.uploaded_at,
        expiresAt: row.expires_at,
      }));
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }

  async getRequestAttachment(employeeId: string, attachmentId: string) {
    const identifier = employeeId.trim();
    const target = attachmentId.trim();
    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }
    if (!target) {
      throw new BadRequestException('attachmentId must not be empty');
    }
    try {
      const employeeResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM employees WHERE id::text = $1 OR employee_code = $1 LIMIT 1`,
        [identifier],
      );
      const employeePk = employeeResult.rows[0]?.id;
      if (!employeePk) {
        throw new NotFoundException('Attachment not found.');
      }
      const result = await this.pool.query<{
        id: string;
        original_name: string;
        stored_name: string;
        mime_type: string;
        size_bytes: string;
        storage_path: string;
        expires_at: Date;
      }>(
        `SELECT id, original_name, stored_name, mime_type, size_bytes, storage_path, expires_at
         FROM request_attachments
         WHERE id = $1 AND employee_id = $2
         LIMIT 1`,
        [target, employeePk],
      );
      const row = result.rows[0];
      if (!row) {
        throw new NotFoundException('Attachment not found.');
      }
      return {
        id: row.id,
        originalName: row.original_name,
        storedName: row.stored_name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        storagePath: row.storage_path,
        expiresAt: row.expires_at,
      };
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      throw new BadGatewayException('Database request failed');
    }
  }

  async deleteRequestAttachment(employeeId: string, attachmentId: string) {
    const identifier = employeeId.trim();
    const target = attachmentId.trim();
    if (!identifier) {
      throw new BadRequestException('employeeId must not be empty');
    }
    if (!target) {
      throw new BadRequestException('attachmentId must not be empty');
    }
    try {
      const employeeResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM employees WHERE id::text = $1 OR employee_code = $1 LIMIT 1`,
        [identifier],
      );
      const employeePk = employeeResult.rows[0]?.id;
      if (!employeePk) {
        throw new NotFoundException('Attachment not found.');
      }
      const result = await this.pool.query<{ storage_path: string }>(
        `DELETE FROM request_attachments
         WHERE id = $1 AND employee_id = $2
         RETURNING storage_path`,
        [target, employeePk],
      );
      if (result.rowCount === 0) {
        throw new NotFoundException('Attachment not found.');
      }
      return result.rows[0].storage_path;
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      throw new BadGatewayException('Database request failed');
    }
  }

  async findExpiredAttachmentPaths(now: Date) {
    try {
      const result = await this.pool.query<{
        id: string;
        storage_path: string;
      }>(
        `DELETE FROM request_attachments
         WHERE expires_at <= $1
         RETURNING id, storage_path`,
        [now],
      );
      return result.rows;
    } catch {
      throw new BadGatewayException('Database request failed');
    }
  }
}
