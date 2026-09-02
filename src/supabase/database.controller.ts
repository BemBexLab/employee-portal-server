import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';

@Controller('database')
export class DatabaseController {
  constructor(private readonly supabaseService: SupabaseService) {}

  @Get('data')
  getDatabaseData(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.supabaseService.getDatabaseData(limit, offset, employeeId);
  }
}
