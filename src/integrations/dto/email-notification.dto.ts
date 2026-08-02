import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString,
  MaxLength, ValidateNested,
} from 'class-validator';

const SEVERITIES = ['Info', 'Warning', 'Minor', 'Major', 'Critical'];

export class RecipientDto {
  @IsEmail()
  email!: string;

  @IsOptional() @IsString() @MaxLength(120)
  label?: string;
}

export class AlertEmailSettingsDto {
  @IsIn(SEVERITIES)
  min_severity!: string;

  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RecipientDto)
  recipients!: RecipientDto[];

  @IsArray() @ArrayMaxSize(1000) @IsInt({ each: true })
  user_ids!: number[];

  @IsBoolean()
  enabled!: boolean;
}

export class UserAlertEmailPrefsDto {
  @IsIn(SEVERITIES)
  min_severity!: string;

  @IsBoolean()
  enabled!: boolean;
}

const REPORT_TYPES = ['device-health', 'interface-utilization', 'alert-summary', 'availability'];
const RANGES = ['24h', '7d', '30d'];

export class CreateReportSubscriptionDto {
  // Required (not optional) even though the DB column has a default: the
  // service does a straight INSERT with this value, so an omitted label
  // would be sent as an explicit NULL, not "use the column default".
  @IsString() @MaxLength(120)
  label!: string;

  @IsIn(REPORT_TYPES)
  report_type!: string;

  @IsIn(RANGES)
  range!: string;

  @IsString() @MaxLength(120)
  cron_schedule!: string;

  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RecipientDto)
  recipients!: RecipientDto[];

  @IsArray() @ArrayMaxSize(1000) @IsInt({ each: true })
  user_ids!: number[];

  @IsBoolean()
  enabled!: boolean;
}

// Despite the "Partial<ReportEmailSubscription>" service signature,
// EmailNotificationsService.updateReportSubscription does a full-column
// UPDATE (not COALESCE), so every field is effectively required here too —
// an omitted field would null out a NOT NULL column server-side rather than
// leaving it unchanged.
export class UpdateReportSubscriptionDto extends CreateReportSubscriptionDto {}
