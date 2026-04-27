import { Module } from '@nestjs/common';
import { UserController } from './user.controller.js';
import { UserService } from './user.service.js';

/**
 * UserModule (Sprint B / Task #93) — admin/staff user list endpoint.
 *
 * Powers the maintenance assignee dropdown (Task #89). Exports
 * `UserService` so a future audit-log "actor resolution" or team-page
 * module can reuse it without re-importing internals.
 */
@Module({
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
