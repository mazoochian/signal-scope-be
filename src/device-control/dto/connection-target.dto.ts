import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SetConnectionTargetDto {
  @IsIn(['ssh', 'telnet', 'snmp'])
  transport!: 'ssh' | 'telnet' | 'snmp';

  @IsString() @MaxLength(255)
  host!: string;

  @IsInt() @Min(1) @Max(65535)
  port!: number;

  @IsIn(['real', 'eve-ng', 'docker-simulator', 'planned'])
  kind!: 'real' | 'eve-ng' | 'docker-simulator' | 'planned';

  @IsOptional() @IsInt()
  proxyDeviceId?: number;

  @IsOptional() @IsString() @MaxLength(128)
  proxySelector?: string;
}

export class SetCredentialDto {
  @IsIn(['ssh_password', 'ssh_key', 'telnet_password', 'enable_secret', 'snmp_v2c_community', 'snmpv3_auth', 'snmpv3_priv', 'api_token'])
  kind!: string;

  @IsOptional() @IsString() @MaxLength(128)
  username?: string;

  @IsString() @MaxLength(4096)
  secret!: string;
}

export class SetVendorProfileDto {
  @IsString() @MaxLength(64)
  vendorProfileId!: string;

  @IsIn(['switch', 'router', 'ap', 'firewall', 'other'])
  deviceClass!: string;
}
