import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const PROVIDER_TYPES = ['google', 'oidc', 'telegram', 'slack'];

export class CreateOidcProviderDto {
  @IsString() @MaxLength(120)
  name!: string;

  @IsIn(PROVIDER_TYPES)
  providerType!: string;

  @IsOptional() @IsBoolean()
  isEnabled?: boolean;

  @IsOptional() @IsString() @MaxLength(255)
  clientId?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  clientSecret?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  discoveryUrl?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  authorizationEndpoint?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  tokenEndpoint?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  userinfoEndpoint?: string;

  @IsOptional() @IsString() @MaxLength(255)
  scopes?: string;

  @IsOptional() @IsString() @MaxLength(255)
  botToken?: string;

  @IsOptional() @IsString() @MaxLength(120)
  botUsername?: string;

  @IsOptional() @IsString() @MaxLength(60)
  buttonText?: string;
}

export class UpdateOidcProviderDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsIn(PROVIDER_TYPES)
  providerType?: string;

  @IsOptional() @IsBoolean()
  isEnabled?: boolean;

  @IsOptional() @IsString() @MaxLength(255)
  clientId?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  clientSecret?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  discoveryUrl?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  authorizationEndpoint?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  tokenEndpoint?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  userinfoEndpoint?: string;

  @IsOptional() @IsString() @MaxLength(255)
  scopes?: string;

  @IsOptional() @IsString() @MaxLength(255)
  botToken?: string;

  @IsOptional() @IsString() @MaxLength(120)
  botUsername?: string;

  @IsOptional() @IsString() @MaxLength(60)
  buttonText?: string;
}
