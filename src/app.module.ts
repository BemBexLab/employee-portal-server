import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseService } from './supabase/supabase.service';
import { DatabaseController } from './supabase/database.controller';
import { PortalController } from './portal/portal.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController, DatabaseController, PortalController],
  providers: [AppService, SupabaseService],
})
export class AppModule {}
