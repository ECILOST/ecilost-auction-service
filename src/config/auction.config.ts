import { plainToInstance } from 'class-transformer';
import { IsNotEmpty, IsString, IsUrl, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsNotEmpty() @IsString() DATABASE_URL: string;
  @IsUrl({ require_tld: false }) AUTH_JWKS_URL: string;
  @IsNotEmpty() @IsString() JWT_ISSUER: string;
  @IsNotEmpty() @IsString() JWT_AUDIENCE: string;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const parsed = plainToInstance(EnvironmentVariables, raw);
  const errors = validateSync(parsed, { skipMissingProperties: false });
  if (errors.length) throw new Error(`Configuracion invalida: ${errors.map((x) => x.property).join(', ')}`);
  return parsed;
}

export class AuctionConfig {
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly authJwksUrl: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  constructor() {
    const env = validateEnv(process.env);
    this.databaseUrl = env.DATABASE_URL;
    this.databaseSchema = new URL(env.DATABASE_URL).searchParams.get('schema') ?? 'auction';
    this.authJwksUrl = env.AUTH_JWKS_URL;
    this.jwtIssuer = env.JWT_ISSUER;
    this.jwtAudience = env.JWT_AUDIENCE;
  }
}
