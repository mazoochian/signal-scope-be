import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

const METRICS = ['availability', 'cpu', 'memory', 'latency', 'packet_loss', 'interface_util'];
const OPERATORS = ['>=', '<=', '='];

export class CreateSlaParameterDto {
  @IsString() @MaxLength(120)
  name!: string;

  @IsIn(METRICS)
  metric!: string;

  @IsNumber()
  target_value!: number;

  @IsIn(OPERATORS)
  operator!: string;

  @IsString() @MaxLength(60)
  scope_type!: string;

  @IsOptional() @IsString() @MaxLength(120)
  scope_value?: string;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

export class UpdateSlaParameterDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsIn(METRICS)
  metric?: string;

  @IsOptional() @IsNumber()
  target_value?: number;

  @IsOptional() @IsIn(OPERATORS)
  operator?: string;

  @IsOptional() @IsString() @MaxLength(60)
  scope_type?: string;

  @IsOptional() @IsString() @MaxLength(120)
  scope_value?: string;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}
