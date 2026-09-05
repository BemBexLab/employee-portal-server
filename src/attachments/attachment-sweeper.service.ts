import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { deleteAttachmentFile } from './attachment-storage';

const SWEEP_INTERVAL_MS = 1000 * 60 * 30;

@Injectable()
export class AttachmentSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly supabaseService: SupabaseService) {}

  onModuleInit() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    if (
      typeof this.timer === 'object' &&
      this.timer !== null &&
      'unref' in this.timer
    ) {
      (this.timer as { unref?: () => void }).unref?.();
    }
    setTimeout(() => {
      void this.sweep();
    }, 5_000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await this.supabaseService.findExpiredAttachmentPaths(
        new Date(),
      );
      if (expired.length === 0) return;
      this.logger.log(`Sweeping ${expired.length} expired attachment(s).`);
      await Promise.all(
        expired.map(async (entry) => {
          await deleteAttachmentFile(entry.storage_path);
        }),
      );
    } catch (err) {
      this.logger.error(
        `Attachment sweep failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
