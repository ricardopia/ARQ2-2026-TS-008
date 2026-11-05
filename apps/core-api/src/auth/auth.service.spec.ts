jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
  argon2id: 2,
}));

import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { plainToInstance } from 'class-transformer';
import { QueryFailedError, type Repository } from 'typeorm';
import { ProblemException } from '../common/problem';
import { User } from '../users/user.entity';
import { ACCESS_TOKEN_TTL_SECONDS, AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

const hashMock = argon2.hash as jest.MockedFunction<typeof argon2.hash>;
const verifyMock = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

const alice: User = {
  id: '0a11ce00-0000-4000-8000-000000000001',
  email: 'alice@acme.test',
  displayName: 'Alice',
  passwordHash: '$argon2id$fake',
  createdAt: new Date('2026-10-13T14:00:00.000Z'),
};

describe('AuthService', () => {
  let service: AuthService;
  let jwt: JwtService;
  let users: { findOneBy: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    users = {
      findOneBy: jest.fn(),
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'test-secret',
          signOptions: { expiresIn: '8h' },
        }),
      ],
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: users },
      ],
    }).compile();

    service = module.get(AuthService);
    jwt = module.get(JwtService);
  });

  describe('register', () => {
    it('hashes the password with argon2id and returns the public user', async () => {
      hashMock.mockResolvedValue('$argon2id$hashed');
      users.save.mockResolvedValue(alice);

      const result = await service.register({
        email: 'alice@acme.test',
        password: 'correct-horse-battery',
        displayName: 'Alice',
      } as RegisterDto);

      expect(hashMock).toHaveBeenCalledWith('correct-horse-battery', {
        type: 2,
      });
      expect(users.save).toHaveBeenCalledWith({
        email: 'alice@acme.test',
        displayName: 'Alice',
        passwordHash: '$argon2id$hashed',
      });
      expect(result).toEqual({
        id: alice.id,
        email: alice.email,
        displayName: alice.displayName,
        createdAt: alice.createdAt,
      });
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('maps a unique violation to 409 EMAIL_ALREADY_REGISTERED', async () => {
      hashMock.mockResolvedValue('$argon2id$hashed');
      const duplicate = new QueryFailedError('insert into users', [], {
        code: '23505',
      } as never);
      users.save.mockRejectedValue(duplicate);

      const error = await service
        .register({
          email: 'alice@acme.test',
          password: 'correct-horse-battery',
          displayName: 'Alice',
        } as RegisterDto)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemException);
      expect((error as ProblemException).getStatus()).toBe(409);
      expect((error as ProblemException).code).toBe(
        'EMAIL_ALREADY_REGISTERED',
      );
    });
  });

  describe('login', () => {
    const dto = { email: 'alice@acme.test', password: 'correct-horse-battery' };

    it('returns a Bearer token that expires in 28800 seconds with sub/email claims', async () => {
      users.findOneBy.mockResolvedValue(alice);
      verifyMock.mockResolvedValue(true);

      const result = await service.login(dto as LoginDto);

      expect(users.findOneBy).toHaveBeenCalledWith({ email: dto.email });
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
      expect(result.expiresIn).toBe(28800);
      expect(result.user).toEqual({
        id: alice.id,
        email: alice.email,
        displayName: alice.displayName,
        createdAt: alice.createdAt,
      });

      const claims = jwt.verify<{ sub: string; email: string; iat: number; exp: number }>(
        result.accessToken,
      );
      expect(claims.sub).toBe(alice.id);
      expect(claims.email).toBe(alice.email);
      expect(typeof claims.iat).toBe('number');
      expect(typeof claims.exp).toBe('number');
      expect(claims.exp - claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
      expect(Object.keys(claims).sort()).toEqual(['email', 'exp', 'iat', 'sub']);
    });

    it('rejects a wrong password with 401 INVALID_CREDENTIALS and issues no token', async () => {
      users.findOneBy.mockResolvedValue(alice);
      verifyMock.mockResolvedValue(false);
      const signSpy = jest.spyOn(jwt, 'signAsync');

      const error = await service.login(dto as LoginDto).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemException);
      expect((error as ProblemException).getStatus()).toBe(401);
      expect((error as ProblemException).code).toBe('INVALID_CREDENTIALS');
      expect(signSpy).not.toHaveBeenCalled();
    });

    it('rejects an unknown email with the same 401 answer (no enumeration)', async () => {
      users.findOneBy.mockResolvedValue(null);
      verifyMock.mockResolvedValue(false);

      const error = await service.login(dto as LoginDto).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProblemException);
      expect((error as ProblemException).getStatus()).toBe(401);
      expect((error as ProblemException).code).toBe('INVALID_CREDENTIALS');
      // A verification still runs against a dummy hash.
      expect(verifyMock).toHaveBeenCalled();
    });

    it('normalizes the email before looking it up', async () => {
      const input = plainToInstance(LoginDto, {
        email: '  Alice@ACME.test ',
        password: 'correct-horse-battery',
      });

      expect(input.email).toBe('alice@acme.test');
    });
  });
});
