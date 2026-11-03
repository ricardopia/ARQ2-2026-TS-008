import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route or controller as reachable without an access token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
