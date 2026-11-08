import { IsArray, IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength, IsUUID } from 'class-validator';

export class CreateTaskDto {
  @IsUUID('4')
  @IsNotEmpty()
  columnId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  assigneeIds?: string[];

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
