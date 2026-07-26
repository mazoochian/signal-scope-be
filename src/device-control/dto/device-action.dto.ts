import { IsIn, IsInt, IsOptional, IsString, MaxLength, ArrayMaxSize, IsArray, Min, Max } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { DeviceAction, DeviceActionKind, VendorAdapter } from '../adapters/vendor-adapter.interface';
import { validateInterfaceName, validateVlanId, validateDescription } from '../sanitization/cli-command-sanitizer';

const ACTION_KINDS: DeviceActionKind[] = [
  'port.setAdminStatus',
  'port.setDescription',
  'vlan.setPvid',
  'vlan.setTrunkAllowed',
  'vlan.create',
  'config.save',
  'interface.setIpAddress',
  'route.static.upsert',
];

/**
 * Flat wire shape for a DeviceAction. class-validator doesn't have mature
 * support for discriminated unions, so this DTO validates the fields it
 * *can* validate statically (types, lengths, ranges) and toDeviceAction()
 * below does the per-kind semantic validation (required-field presence,
 * vendor-specific interface-name pattern) that needs runtime adapter
 * context — this is the "already-validated typed parameters" gate that
 * buildCliPlan/buildSnmpPlan rely on never having to sanitize themselves.
 */
export class DeviceActionDto {
  @IsIn(ACTION_KINDS)
  kind!: DeviceActionKind;

  @IsOptional() @IsString() @MaxLength(64)
  interfaceName?: string;

  @IsOptional() @IsIn(['up', 'down'])
  adminStatus?: 'up' | 'down';

  @IsOptional() @IsString() @MaxLength(200)
  description?: string;

  @IsOptional() @IsInt() @Min(1) @Max(4094)
  vlanId?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(64) @IsInt({ each: true })
  vlanIds?: number[];

  @IsOptional() @IsString() @MaxLength(64)
  name?: string;

  @IsOptional() @IsString() @MaxLength(64)
  ipAddress?: string;

  @IsOptional() @IsInt() @Min(1) @Max(32)
  prefixLength?: number;

  @IsOptional() @IsString() @MaxLength(64)
  destinationCidr?: string;

  @IsOptional() @IsString() @MaxLength(64)
  nextHop?: string;
}

export function toDeviceAction(dto: DeviceActionDto, adapter: VendorAdapter): DeviceAction {
  const requireInterfaceName = (): string => {
    if (!dto.interfaceName || !validateInterfaceName(dto.interfaceName, adapter.interfaceNamePattern)) {
      throw new BadRequestException(`interfaceName is required and must match this vendor's naming pattern (${adapter.interfaceNamePattern})`);
    }
    return dto.interfaceName;
  };

  switch (dto.kind) {
    case 'port.setAdminStatus':
      if (!dto.adminStatus) throw new BadRequestException('adminStatus is required');
      return { kind: dto.kind, interfaceName: requireInterfaceName(), adminStatus: dto.adminStatus };

    case 'port.setDescription':
      if (!dto.description || !validateDescription(dto.description)) throw new BadRequestException('description is required and must be a valid CLI-safe string');
      return { kind: dto.kind, interfaceName: requireInterfaceName(), description: dto.description };

    case 'vlan.setPvid':
      if (dto.vlanId == null || !validateVlanId(dto.vlanId)) throw new BadRequestException('vlanId must be an integer 1-4094');
      return { kind: dto.kind, interfaceName: requireInterfaceName(), vlanId: dto.vlanId };

    case 'vlan.setTrunkAllowed':
      if (!dto.vlanIds || dto.vlanIds.length === 0 || !dto.vlanIds.every(validateVlanId)) throw new BadRequestException('vlanIds must be a non-empty array of integers 1-4094');
      return { kind: dto.kind, interfaceName: requireInterfaceName(), vlanIds: dto.vlanIds };

    case 'vlan.create':
      if (dto.vlanId == null || !validateVlanId(dto.vlanId)) throw new BadRequestException('vlanId must be an integer 1-4094');
      if (!dto.name || !validateDescription(dto.name)) throw new BadRequestException('name is required and must be a valid CLI-safe string');
      return { kind: dto.kind, vlanId: dto.vlanId, name: dto.name };

    case 'config.save':
      return { kind: dto.kind };

    case 'interface.setIpAddress':
      if (!dto.ipAddress || !dto.prefixLength) throw new BadRequestException('ipAddress and prefixLength are required');
      return { kind: dto.kind, interfaceName: requireInterfaceName(), ipAddress: dto.ipAddress, prefixLength: dto.prefixLength };

    case 'route.static.upsert':
      if (!dto.destinationCidr || !dto.nextHop) throw new BadRequestException('destinationCidr and nextHop are required');
      return { kind: dto.kind, destinationCidr: dto.destinationCidr, nextHop: dto.nextHop };

    default:
      throw new BadRequestException(`Unknown action kind`);
  }
}
