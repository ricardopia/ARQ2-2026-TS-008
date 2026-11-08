import { IsNotEmpty, IsUUID } from 'class-validator';

export class MoveTaskDto {
  @IsUUID('4')
  @IsNotEmpty()
  columnId: string;
}
