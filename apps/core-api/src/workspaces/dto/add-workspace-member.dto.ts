import { Transform } from 'class-transformer';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { WORKSPACE_ROLES, type WorkspaceRole } from '../workspace-member.entity';

export class AddWorkspaceMemberDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsIn([...WORKSPACE_ROLES])
  role: WorkspaceRole;
}
