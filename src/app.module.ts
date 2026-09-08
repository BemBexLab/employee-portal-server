import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';
import { DatabaseController } from './database/database.controller';
import { PortalController } from './portal/portal.controller';
import { AttachmentSweeper } from './attachments/attachment-sweeper.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController, DatabaseController, PortalController],
  providers: [AppService, DatabaseService, AttachmentSweeper],
})
export class AppModule {}
