import { IsIn, IsNotEmpty, IsUUID } from 'class-validator';
import { BOARD_ROLES, type BoardRole } from '../board-member.entity';

export class AddBoardMemberDto {
  @IsUUID('4')
  @IsNotEmpty()
  userId: string;

  @IsIn([...BOARD_ROLES])
  role: BoardRole;
}
