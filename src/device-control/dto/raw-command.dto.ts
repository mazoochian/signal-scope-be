import { IsString, MaxLength, MinLength } from 'class-validator';

/** Raw CLI passthrough — gated separately (device-control-raw permission) and always run through sanitization/cli-command-sanitizer.ts before ever reaching a transport. */
export class RawCommandDto {
  @IsString() @MinLength(1) @MaxLength(500)
  line!: string;
}
