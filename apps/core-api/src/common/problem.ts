import { HttpException, HttpStatus } from '@nestjs/common';

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  correlationId: string;
};

export class ProblemException extends HttpException {
  readonly code: string;
  readonly title: string;
  readonly detail: string;

  constructor(status: HttpStatus, code: string, title: string, detail: string) {
    super({ code, title, detail }, status);
    this.code = code;
    this.title = title;
    this.detail = detail;
  }
}
