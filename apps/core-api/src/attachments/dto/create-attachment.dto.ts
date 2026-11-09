import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

/** Content types accepted for uploads (spec section 3.4). */
export const ATTACHMENT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/vnd.adobe.photoshop',
  'application/postscript',
  'application/zip',
] as const;

export const MAX_ATTACHMENT_SIZE_BYTES = 262144000; // 250 MiB

export class CreateAttachmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;
}
