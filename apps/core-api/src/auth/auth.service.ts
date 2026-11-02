import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { QueryFailedError, Repository } from 'typeorm';
import { ProblemException } from '../common/problem';
import { User } from '../users/user.entity';
import { RegisterDto } from './dto/register.dto';

export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
};

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async register(dto: RegisterDto): Promise<PublicUser> {
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    try {
      const user = await this.users.save(
        this.users.create({
          email: dto.email,
          displayName: dto.displayName,
          passwordHash,
        }),
      );
      return toPublicUser(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'EMAIL_ALREADY_REGISTERED',
          'Email already registered',
          'An account with this email already exists.',
        );
      }
      throw error;
    }
  }
}

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    typeof error.driverError === 'object' &&
    error.driverError !== null &&
    'code' in error.driverError &&
    error.driverError.code === '23505'
  );
}
