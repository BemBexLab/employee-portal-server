import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../supabase/supabase.service';
import {
  MAX_FILES_PER_REQUEST,
  MAX_FILE_SIZE_BYTES,
  computeExpiresAt,
  deleteAttachmentFile,
  isAllowedAttachment,
  saveAttachment,
} from '../attachments/attachment-storage';
import type { StoredAttachment } from '../attachments/attachment-storage';

type LoginBody = {
  identity?: unknown;
  password?: unknown;
};

type CreateRequestBody = {
  kind?: unknown;
  leaveCategory?: unknown;
  fromDate?: unknown;
  toDate?: unknown;
  reason?: unknown;
  note?: unknown;
};

type CreateCorrectionBody = {
  dailyAttendanceId?: unknown;
  complaintType?: unknown;
  expectedCheckIn?: unknown;
  expectedCheckOut?: unknown;
  description?: unknown;
};

const COMPLAINT_TYPES = [
  'INCORRECT_CHECK_IN',
  'INCORRECT_CHECK_OUT',
  'INCORRECT_STATUS',
  'MISSING_ATTENDANCE',
  'OTHER',
] as const;
type ComplaintType = (typeof COMPLAINT_TYPES)[number];

function isComplaintType(value: unknown): value is ComplaintType {
  return (
    typeof value === 'string' &&
    (COMPLAINT_TYPES as readonly string[]).includes(value)
  );
}

const LEAVE_CATEGORIES = [
  'ANNUAL_LEAVE',
  'SICK_LEAVE',
  'CASUAL_LEAVE',
  'UNPAID_LEAVE',
] as const;
type LeaveCategory = (typeof LEAVE_CATEGORIES)[number];

function isLeaveCategory(value: unknown): value is LeaveCategory {
  return (
    typeof value === 'string' &&
    (LEAVE_CATEGORIES as readonly string[]).includes(value)
  );
}

const SESSION_COOKIE = 'portal_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

@Controller('portal')
export class PortalController {
  constructor(private readonly supabaseService: SupabaseService) {}

  @Get('employees/:employeeId')
  async getEmployeePortal(@Param('employeeId') employeeId: string) {
    const data = await this.supabaseService.getEmployeePortal(employeeId);
    if (!data) throw new NotFoundException('Employee not found');
    return data;
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const identity =
      typeof body.identity === 'string' ? body.identity.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!identity || !password) {
      throw new UnauthorizedException(
        'Enter your employee ID or work email and your password.',
      );
    }

    const record = await this.supabaseService.findEmployeeCredential(identity);

    if (!record || !record.isActive || !record.passwordHash) {
      throw new UnauthorizedException('No employee matches those details.');
    }

    const ok = await bcrypt.compare(password, record.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('No employee matches those details.');
    }

    const secret = process.env.COOKIE_SECRET ?? process.env.JWT_SECRET ?? '';
    if (!secret) {
      throw new UnauthorizedException(
        'Server session secret is not configured.',
      );
    }

    response.cookie(SESSION_COOKIE, record.employeeCode, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      signed: true,
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });

    return {
      employee: {
        id: record.id,
        employeeCode: record.employeeCode,
        name: record.name,
        email: record.email,
      },
    };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    return null;
  }

  @Get('requests')
  async listRequests(@Req() request: Request) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    return this.supabaseService.listRequests(employeeCode);
  }

  @Post('requests')
  @HttpCode(201)
  @UseInterceptors(
    FilesInterceptor('attachments', MAX_FILES_PER_REQUEST, {
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
    }),
  )
  async createRequest(
    @Req() request: Request,
    @Body() body: CreateRequestBody,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }

    const kind =
      body.kind === 'LEAVE' || body.kind === 'REMOTE_WORK' ? body.kind : null;
    if (!kind) {
      throw new UnauthorizedException('Invalid request kind.');
    }

    const fromDate =
      typeof body.fromDate === 'string' ? body.fromDate.trim() : '';
    const toDate = typeof body.toDate === 'string' ? body.toDate.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const note =
      typeof body.note === 'string' && body.note.trim().length > 0
        ? body.note.trim()
        : undefined;

    if (!fromDate || !toDate) {
      throw new UnauthorizedException('Date range is required.');
    }
    if (!reason) {
      throw new UnauthorizedException('Reason is required.');
    }
    if (kind === 'LEAVE' && !isLeaveCategory(body.leaveCategory)) {
      throw new UnauthorizedException('Leave category is required.');
    }

    const incomingFiles = Array.isArray(
      (request as Request & { files?: unknown }).files,
    )
      ? ((request as Request & { files?: Express.Multer.File[] }).files ?? [])
      : [];

    const stored: StoredAttachment[] = [];
    const failedReasons: string[] = [];
    for (const file of incomingFiles) {
      const originalName = file.originalname;
      const mimeType = file.mimetype || 'application/octet-stream';
      if (!isAllowedAttachment(originalName, mimeType)) {
        failedReasons.push(`${originalName}: file type not allowed`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        failedReasons.push(`${originalName}: exceeds the 10 MB limit`);
        continue;
      }
      try {
        stored.push(await saveAttachment(originalName, mimeType, file.buffer));
      } catch (err) {
        failedReasons.push(
          `${originalName}: ${err instanceof Error ? err.message : 'upload failed'}`,
        );
      }
    }

    if (failedReasons.length > 0 && stored.length === 0) {
      await Promise.all(
        stored.map((entry) => deleteAttachmentFile(entry.storagePath)),
      );
      throw new BadRequestException(failedReasons.join('; '));
    }

    let created: {
      id: string;
      submittedAt: Date | string;
      organizationId: string;
      employeeId: string;
    };
    try {
      created = await this.supabaseService.createRequest(employeeCode, {
        kind,
        leaveCategory:
          kind === 'LEAVE' && isLeaveCategory(body.leaveCategory)
            ? body.leaveCategory
            : undefined,
        fromDate,
        toDate,
        reason,
        note,
      });
    } catch (err) {
      await Promise.all(
        stored.map((entry) => deleteAttachmentFile(entry.storagePath)),
      );
      throw err;
    }

    let attachments: Array<{
      id: string;
      originalName: string;
      storedName: string;
      mimeType: string;
      sizeBytes: number;
      uploadedAt: Date;
      expiresAt: Date;
    }> = [];
    if (stored.length > 0) {
      try {
        attachments = await this.supabaseService.createRequestAttachments({
          requestId: created.id,
          organizationId: created.organizationId,
          employeeId: created.employeeId,
          expiresAt: computeExpiresAt(),
          files: stored,
        });
      } catch (err) {
        await Promise.all(
          stored.map((entry) => deleteAttachmentFile(entry.storagePath)),
        );
        throw err;
      }
    }

    return {
      id: created.id,
      submittedAt: created.submittedAt,
      attachments,
      ...(failedReasons.length > 0 ? { warnings: failedReasons } : {}),
    };
  }

  @Delete('requests/:requestId')
  @HttpCode(204)
  async deleteRequest(
    @Param('requestId') requestId: string,
    @Req() request: Request,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    const paths = await this.supabaseService.deletePendingRequest(
      employeeCode,
      requestId,
    );
    await Promise.all(
      paths.map((entry) => deleteAttachmentFile(entry.storagePath)),
    );
  }

  @Get('requests/:requestId/attachments')
  async listRequestAttachments(
    @Param('requestId') requestId: string,
    @Req() request: Request,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    return this.supabaseService.listRequestAttachments(requestId);
  }

  @Get('requests/:requestId/attachments/:attachmentId')
  async downloadRequestAttachment(
    @Param('requestId') _requestId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    const attachment = await this.supabaseService.getRequestAttachment(
      employeeCode,
      attachmentId,
    );
    if (attachment.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException('Attachment has expired.');
    }
    const { promises: fs } = await import('fs');
    try {
      const buffer = await fs.readFile(attachment.storagePath);
      response.setHeader(
        'Content-Type',
        attachment.mimeType || 'application/octet-stream',
      );
      const encoded = encodeURIComponent(attachment.originalName);
      response.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encoded}`,
      );
      response.setHeader('Content-Length', String(buffer.length));
      response.status(200).end(buffer);
    } catch {
      throw new NotFoundException('Attachment file is missing.');
    }
  }

  @Delete('requests/:requestId/attachments/:attachmentId')
  @HttpCode(204)
  async deleteRequestAttachment(
    @Param('requestId') _requestId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: Request,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    const storagePath = await this.supabaseService.deleteRequestAttachment(
      employeeCode,
      attachmentId,
    );
    await deleteAttachmentFile(storagePath);
  }

  @Get('corrections')
  async listCorrections(@Req() request: Request) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    return this.supabaseService.listCorrections(employeeCode);
  }

  @Get('deductions')
  async getDeductions(
    @Query('cycle') cycle: string | undefined,
    @Req() request: Request,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    const cycleKey = cycle?.trim() || undefined;
    const data = await this.supabaseService.getPayrollDeduction(
      employeeCode,
      cycleKey,
    );
    if (!data) {
      throw new NotFoundException('No deduction record found.');
    }
    return data;
  }

  @Post('corrections')
  @HttpCode(201)
  async createCorrection(
    @Body() body: CreateCorrectionBody,
    @Req() request: Request,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }

    if (!isComplaintType(body.complaintType)) {
      throw new UnauthorizedException('Invalid complaint type.');
    }
    const description =
      typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) {
      throw new UnauthorizedException('Description is required.');
    }

    return this.supabaseService.createCorrection(employeeCode, {
      dailyAttendanceId:
        typeof body.dailyAttendanceId === 'string'
          ? body.dailyAttendanceId
          : null,
      complaintType: body.complaintType,
      expectedCheckIn:
        typeof body.expectedCheckIn === 'string' ? body.expectedCheckIn : null,
      expectedCheckOut:
        typeof body.expectedCheckOut === 'string'
          ? body.expectedCheckOut
          : null,
      description,
    });
  }

  @Delete('corrections/:correctionId')
  @HttpCode(204)
  async deleteCorrection(
    @Param('correctionId') correctionId: string,
    @Req() request: Request,
  ) {
    const employeeCode = await this.resolveEmployeeCode(request);
    if (!employeeCode) {
      throw new UnauthorizedException('Not signed in.');
    }
    await this.supabaseService.deletePendingCorrection(
      employeeCode,
      correctionId,
    );
  }

  private employeeCodeFromCookies(request: Request): string | null {
    const signed = request.signedCookies?.[SESSION_COOKIE];
    if (typeof signed === 'string' && signed.length > 0) return signed;
    const fallback = request.cookies?.[SESSION_COOKIE];
    return typeof fallback === 'string' && fallback.length > 0
      ? fallback
      : null;
  }

  private async resolveEmployeeCode(request: Request): Promise<string | null> {
    const trusted = this.trustedBffHeader(request);
    if (trusted) return trusted;

    const fromCookie = this.employeeCodeFromCookies(request);
    if (fromCookie) return fromCookie;

    return null;
  }

  private trustedBffHeader(request: Request): string | null {
    const expected = process.env.BFF_SHARED_SECRET;
    if (!expected) return null;
    const provided = request.headers['x-bff-token'];
    if (provided !== expected) return null;
    const employeeCode = request.headers['x-employee-code'];
    return typeof employeeCode === 'string' && employeeCode.length > 0
      ? employeeCode
      : null;
  }
}
