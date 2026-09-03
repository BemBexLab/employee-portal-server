import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { SupabaseService } from './supabase.service';

describe('SupabaseService', () => {
  const values: Record<string, string> = {
    DATABASE_URL: 'postgresql://example',
    SUPABASE_TABLE: 'employees',
  };
  const configService = {
    get: jest.fn((name: string) => values[name]),
  } as unknown as ConfigService;
  const query = jest.fn();
  const end = jest.fn();
  const pool = { query, end } as unknown as Pool;
  let service: SupabaseService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SupabaseService(configService, pool);
  });

  it('returns paginated employee data', async () => {
    const employees = [
      {
        id: 1,
        name: 'Ada',
        attendance_summary: {
          total_absent: 1,
          total_half_days: 2,
          absent_days: [{ date: '2026-08-01' }],
          half_days: [{ date: '2026-08-02' }, { date: '2026-08-03' }],
        },
      },
    ];
    query.mockResolvedValue({ rows: employees });

    await expect(service.getEmployees(25, 5)).resolves.toEqual({
      data: employees,
      pagination: { limit: 25, offset: 5, count: 1 },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "employees"'),
      [25, 5],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("attendance.effective_status = 'ABSENT'"),
      [25, 5],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("attendance.effective_status = 'HALF_DAY'"),
      [25, 5],
    );
  });

  it('returns a safe employee portal projection', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'employee-108',
            employee_code: '108',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            is_active: true,
            monthly_salary: '60000.00',
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            department: 'Engineering',
            organization: 'Example Org',
            timezone: 'Asia/Karachi',
            shift_name: 'Night Shift',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'attendance-1',
            date: '2026-08-26',
            first_check_in: new Date('2026-08-26T16:00:00.000Z'),
            last_check_out: new Date('2026-08-27T01:00:00.000Z'),
            working_minutes: 540,
            effective_status: 'PRESENT',
            shift_name: 'Night Shift',
            scheduled_start: new Date('2026-08-26T16:00:00.000Z'),
            scheduled_end: new Date('2026-08-27T01:00:00.000Z'),
            grace_deadline: new Date('2026-08-26T16:15:00.000Z'),
          },
        ],
      });

    await expect(service.getEmployeePortal('108')).resolves.toEqual({
      employee: {
        id: 'employee-108',
        employeeCode: '108',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        isActive: true,
        monthlySalary: 60000,
        joinedAt: new Date('2026-01-01T00:00:00.000Z'),
        department: 'Engineering',
        organization: 'Example Org',
        timeZone: 'Asia/Karachi',
        shiftName: 'Night Shift',
      },
      attendance: [
        {
          id: 'attendance-1',
          date: '2026-08-26',
          firstCheckIn: new Date('2026-08-26T16:00:00.000Z'),
          lastCheckOut: new Date('2026-08-27T01:00:00.000Z'),
          workingMinutes: 540,
          status: 'PRESENT',
          shiftName: 'Night Shift',
          scheduledStart: new Date('2026-08-26T16:00:00.000Z'),
          scheduledEnd: new Date('2026-08-27T01:00:00.000Z'),
          graceDeadline: new Date('2026-08-26T16:15:00.000Z'),
        },
      ],
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('employee.employee_code = $1'),
      ['108'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM daily_attendance AS attendance'),
      ['employee-108'],
    );
  });

  it('returns null when the portal employee does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(service.getEmployeePortal('missing')).resolves.toBeNull();
  });

  it('returns the latest deduction row when no cycle is supplied', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'employee-uuid-108' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            payroll_cycle_month: '2026-08',
            late_days: 0,
            half_days: 3,
            absent_days: 0,
            late_half_day_deduction_days: 1,
            total_deduction_days: 1,
            monthly_salary: '60000.00',
            employee_monthly_salary: '60000.00',
            payroll_days: 32,
            daily_rate: '1875.00',
            deduction_amount: '1875.00',
            calculated_through: '2026-09-04',
          },
        ],
      });

    await expect(service.getPayrollDeduction('108')).resolves.toEqual({
      cycle: '2026-08',
      lateDays: 0,
      halfDays: 3,
      absentDays: 0,
      lateHalfDayDeductionDays: 1,
      totalDeductionDays: 1,
      monthlySalary: 60000,
      payrollDays: 32,
      dailyRate: 1875,
      deductionAmount: 1875,
      calculatedThrough: '2026-09-04',
    });

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'ORDER BY d.payroll_cycle_month DESC, d.updated_at DESC',
      ),
      ['employee-uuid-108'],
    );
    expect(query.mock.calls[1][0]).not.toContain(
      'AND d.payroll_cycle_month = $2',
    );
  });

  it('still filters deductions when a cycle is supplied', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'employee-uuid-108' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      service.getPayrollDeduction('108', '2026-08'),
    ).resolves.toBeNull();

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('AND d.payroll_cycle_month = $2'),
      ['employee-uuid-108', '2026-08'],
    );
  });

  it.each([
    [0, 0],
    [101, 0],
    [10, -1],
  ])('rejects invalid pagination (%i, %i)', async (limit, offset) => {
    await expect(service.getEmployees(limit, offset)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('converts database failures to a gateway error', async () => {
    query.mockRejectedValue(new Error('database unavailable'));

    await expect(service.getEmployees(50, 0)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('returns rows from all non-system tables with the export token', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            table_schema: 'public',
            table_name: 'employees',
            has_employee_id: false,
            has_id: true,
            has_employee_code: true,
          },
          {
            table_schema: 'public',
            table_name: 'teams',
            has_employee_id: false,
            has_id: true,
            has_employee_code: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: '125' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })
      .mockResolvedValueOnce({ rows: [{ id: 10, name: 'Engineering' }] });

    await expect(service.getDatabaseData(25, 5)).resolves.toEqual({
      data: {
        'public.employees': [{ id: 1, name: 'Ada' }],
        'public.teams': [{ id: 10, name: 'Engineering' }],
      },
      tables: ['public.employees', 'public.teams'],
      pagination: {
        'public.employees': { limit: 25, offset: 5, count: 1, total: 125 },
        'public.teams': { limit: 25, offset: 5, count: 1, total: 10 },
      },
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("table_type = 'BASE TABLE'"),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT COUNT(*)::text AS count FROM "public"."employees"',
      undefined,
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'SELECT * FROM "public"."employees" LIMIT $1 OFFSET $2',
      [25, 5],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'SELECT COUNT(*)::text AS count FROM "public"."teams"',
      undefined,
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      'SELECT * FROM "public"."teams" LIMIT $1 OFFSET $2',
      [25, 5],
    );
  });

  it.each([
    [0, 0],
    [101, 0],
    [10, -1],
  ])('rejects invalid database pagination (%i, %i)', async (limit, offset) => {
    await expect(service.getDatabaseData(limit, offset)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('filters employee-owned tables by employeeId', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            table_schema: 'public',
            table_name: 'employees',
            has_employee_id: false,
            has_id: true,
            has_employee_code: true,
          },
          {
            table_schema: 'public',
            table_name: 'daily_attendance',
            has_employee_id: true,
            has_id: true,
            has_employee_code: false,
          },
          {
            table_schema: 'public',
            table_name: 'teams',
            has_employee_id: false,
            has_id: true,
            has_employee_code: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'employee-uuid-108' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 21, employee_id: 7 }] });

    await expect(service.getDatabaseData(50, 0, '108')).resolves.toEqual(
      expect.objectContaining({
        data: {
          'public.employees': [{ id: 7, name: 'Ada' }],
          'public.daily_attendance': [{ id: 21, employee_id: 7 }],
        },
        tables: ['public.employees', 'public.daily_attendance'],
      }),
    );

    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT "id"::text AS id FROM "public"."employees" WHERE "id"::text = $1 OR "employee_code" = $1 LIMIT 1',
      ['108'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      'SELECT COUNT(*)::text AS count FROM "public"."employees" WHERE "id" = $1',
      ['employee-uuid-108'],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'SELECT * FROM "public"."employees" WHERE "id" = $1 LIMIT $2 OFFSET $3',
      ['employee-uuid-108', 50, 0],
    );
    expect(query).toHaveBeenNthCalledWith(
      6,
      'SELECT * FROM "public"."daily_attendance" WHERE "employee_id" = $1 LIMIT $2 OFFSET $3',
      ['employee-uuid-108', 50, 0],
    );
  });

  it('rejects an empty employeeId filter', async () => {
    await expect(service.getDatabaseData(50, 0, '  ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('closes the database pool on shutdown', async () => {
    end.mockResolvedValue(undefined);

    await service.onModuleDestroy();

    expect(end).toHaveBeenCalledTimes(1);
  });
});
