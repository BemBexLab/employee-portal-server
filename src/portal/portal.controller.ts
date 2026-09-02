import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('portal')
export class PortalController {
  constructor(private readonly supabaseService: SupabaseService) {}

  @Get('employees/:employeeId')
  async getEmployeePortal(@Param('employeeId') employeeId: string) {
    const data = await this.supabaseService.getEmployeePortal(employeeId);
    if (!data) throw new NotFoundException('Employee not found');
    return data;
  }
}
