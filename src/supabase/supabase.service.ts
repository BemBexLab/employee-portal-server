import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
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
}
