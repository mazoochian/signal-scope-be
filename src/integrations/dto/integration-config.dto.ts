import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class EmailConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString() @MaxLength(255)
  host!: string;

  @IsString() @MaxLength(10)
  port!: string;

  @IsIn(['starttls', 'ssl', 'none'])
  security!: 'starttls' | 'ssl' | 'none';

  @IsString() @MaxLength(255)
  username!: string;

  // May be the literal sentinel "********" (meaning "leave the stored
  // secret unchanged" — see IntegrationsService) or a new plaintext
  // password to encrypt. Never the plaintext of an already-stored secret.
  @IsString() @MaxLength(1024)
  password!: string;

  @IsString() @MaxLength(120)
  fromName!: string;

  @IsString() @MaxLength(255)
  fromAddress!: string;
}

export class TestEmailConfigDto extends EmailConfigDto {
  @IsOptional() @IsString() @MaxLength(255)
  testRecipient?: string;
}

export class TelegramConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString() @MaxLength(255)
  botToken!: string;

  @IsString() @MaxLength(120)
  defaultChatId!: string;
}

export class SlackConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString() @MaxLength(255)
  botToken!: string;

  @IsString() @MaxLength(120)
  defaultChannel!: string;
}
