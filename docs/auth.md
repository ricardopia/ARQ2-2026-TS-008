# How the Auth Works

This is a short explanation of how authentication works in the TaskMaster API right now.

## Overview

The API Gateway (Nginx) is the only entry point. The Core API (NestJS) does the real work.

## The public endpoints

Only these two are public:

- `POST /api/v1/auth/register` - create an account.
- `POST /api/v1/auth/login` - get an access token.

## What happens

1. **Register** (`POST /auth/register`) - the client sends email, password, display name. The password is hashed with argon2id. A duplicate email answers `409 EMAIL_ALREADY_REGISTERED`.

2. **Login** (`POST /auth/login`) - the client sends email + password. The password is verified with argon2id; if the email is unknown, a dummy hash is verified too (so an unknown email and a wrong password both answer `401 INVALID_CREDENTIALS` - no user enumeration). On success an HS256 JWT is signed with only the claims `sub`, `email`, `iat`, `exp` (8 hours = `expiresIn` 28800 seconds). The response is `{ accessToken, tokenType: 'Bearer', expiresIn: 28800, user }`.

3. **Protected endpoints** - every other endpoint requires the JWT as `Authorization: Bearer <token>`. A global guard verifies it; missing, malformed, invalid or expired tokens answer `401 UNAUTHENTICATED`. Roles are never in the token; the workspace role is read from PostgreSQL per request.

4. **What the client sends** - `Authorization: Bearer <accessToken>`.

5. **What the gateway does** - public paths go straight to the Core API; everything else under `/api/v1/` goes through the gateway `auth_request` to `GET /internal/auth/introspect` on the Core API. That endpoint answers:
   - `204` - token is valid, let the request through;
   - `401` - token is missing/invalid/expired, gateway answers `401 UNAUTHENTICATED`;
   - `404` - wrong/missing `X-Internal-Token` shared secret, endpoint stays hidden.

6. **Errors** - all errors are `application/problem+json` with a `code` (for example `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `USER_NOT_FOUND`, `ALREADY_MEMBER`).

7. **Limits** - the gateway rate-limits public auth routes (10/min per client, answer `429 RATE_LIMITED`) and rejects bodies over 1 MiB (`413 PAYLOAD_TOO_LARGE`). If a required dependency (PostgreSQL) is down, the API answers `503 SERVICE_UNAVAILABLE`.

## The internal token

- `INTERNAL_TOKEN` is a shared secret between the API Gateway and the Core API.
- The gateway sends it as `X-Internal-Token` on the `/_auth_check` subrequest to the Core API's `/internal/auth/introspect`.
- The Core API compares it (constant-time) with the one from its environment; a mismatch means the endpoint answers `404 NOT_FOUND`.

## What happens if ...

- Token missing or invalid → `401 UNAUTHENTICATED` (gateway or Core API).
- Wrong password or unknown email → `401 INVALID_CREDENTIALS` (no enumeration).
- Account already registered → `409 EMAIL_ALREADY_REGISTERED`.
- Unknown email on workspace member add → `404 USER_NOT_FOUND`.
- Adding someone who is already a member → `409 ALREADY_MEMBER`.
- Caller without a workspace role → `404 NOT_FOUND`; caller with a too-low role → `403 FORBIDDEN`.
- Request body invalid/unknown field → `400 VALIDATION_ERROR`.
- Gateway rate limit exceeded → `429 RATE_LIMITED`; body too large → `413 PAYLOAD_TOO_LARGE`; PostgreSQL down → `503 SERVICE_UNAVAILABLE`.

## Where things live

- Core API: `apps/core-api/src/auth/*` (controller, service, guard, internal controller, DTOs, tests), errors in `src/common/problem*`, wired in `src/app.module.ts` and `src/main.ts`.
- Gateway: `infrastructure/nginx/api-gateway/nginx.conf` and `infrastructure/nginx/api-gateway/conf.d/routes.conf`.
- Spec: `docs/spec.md` (sections 3, 5.1, 2.2, error tables, edge cases).
