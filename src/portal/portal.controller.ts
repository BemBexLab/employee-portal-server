import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../supabase/supabase.service';

type LoginBody = {
  identity?: unknown;
  password?: unknown;
};

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
    const password =
      typeof body.password === 'string' ? body.password : '';

    if (!identity || !password) {
      throw new UnauthorizedException(
        'Enter your employee ID or work email and your password.',
      );
    }

    const record = await this.supabaseService.findEmployeeCredential(identity);

    if (!record || !record.isActive || !record.passwordHash) {
      throw new UnauthorizedException(
        'No employee matches those details.',
      );
    }

    const ok = await bcrypt.compare(password, record.passwordHash);
    if (!ok) {
      throw new UnauthorizedException(
        'No employee matches those details.',
      );
    }

    const secret =
      process.env.COOKIE_SECRET ?? process.env.JWT_SECRET ?? '';
    if (!secret) {
      throw new UnauthorizedException('Server session secret is not configured.');
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
}