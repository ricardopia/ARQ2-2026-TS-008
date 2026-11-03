import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { ProblemException } from '../common/problem';
import { User } from '../users/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
};

export type AccessTokenClaims = {
  sub: string;
  email: string;
  iat: number;
  exp: number;
};

export type LoginResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: PublicUser;
};

/** Eight hours, the initial value fixed by spec section 3.1. */
export const ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly jwt: JwtService,
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

  async login(dto: LoginDto): Promise<LoginResponse> {
    const user = await this.users.findOneBy({ email: dto.email });

    // Always run a verification so an unknown email and a wrong password take
    // the same time and return the same answer (no user enumeration).
    const passwordMatches = user
      ? await argon2.verify(user.passwordHash, dto.password)
      : await this.dummyVerify(dto.password);

    if (!user || !passwordMatches) {
      throw new ProblemException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_CREDENTIALS',
        'Invalid credentials',
        'The email or password is incorrect.',
      );
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: toPublicUser(user),
    };
  }

  private async dummyVerify(password: string): Promise<boolean> {
    this.dummyHash ??= argon2.hash(randomUUID(), { type: argon2.argon2id });
    const hash = await this.dummyHash;
    return argon2.verify(hash, password);
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
