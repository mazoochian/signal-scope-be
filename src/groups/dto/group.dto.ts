import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateGroupDto {
  @IsString() @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsString()
  role?: string;
}

export class UpdateGroupDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsString()
  role?: string;
}

export class AddGroupMemberDto {
  @IsInt()
  userId!: number;
}
