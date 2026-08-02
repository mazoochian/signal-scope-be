import {
  IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsOptional() @IsString() @MinLength(8) @MaxLength(200)
  password?: string;

  @IsOptional() @IsString() @MaxLength(120)
  firstName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  lastName?: string;

  @IsOptional() @IsInt() @Min(0) @Max(150)
  age?: number;

  @IsOptional() @IsString()
  role?: string;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(120)
  firstName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  lastName?: string;

  @IsOptional() @IsInt() @Min(0) @Max(150)
  age?: number;

  @IsOptional() @IsString() @MaxLength(2048)
  avatarUrl?: string;

  @IsOptional() @IsString()
  role?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsString() @MinLength(8) @MaxLength(200)
  password?: string;
}

const GRANT_PERMISSIONS = ['read', 'write', 'execute', 'delete', 'manage'];

export class AddGrantDto {
  @IsString() @MaxLength(60)
  resourceType!: string;

  @IsOptional() @IsString() @MaxLength(60)
  resourceId?: string;

  @IsIn(GRANT_PERMISSIONS)
  permission!: string;
}
