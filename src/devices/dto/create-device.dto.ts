import { IsIP, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateDeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsIP()
  ip!: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  vendor!: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  model!: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  role!: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  site!: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  icon!: string;
}
