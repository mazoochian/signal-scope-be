import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DbService } from '../db/db.service';

export interface UserRecord {
  id: number;
  email: string;
  passwordHash: string | null;
  firstName: string | null;
  lastName: string | null;
  age: number | null;
  avatarUrl: string | null;
  role: string;
  isActive: boolean;
  createdAt: Date;
}

export interface UserDto {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  age: number | null;
  avatarUrl: string | null;
  role: string;
  isActive: boolean;
}

export interface AccessGrantDto {
  id: number;
  resourceType: string;
  resourceId: string | null;
  permission: string;
}

export interface CreateUserDto {
  email: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  role?: string;
}

export interface UpdateUserDto {
  firstName?: string;
  lastName?: string;
  age?: number;
  avatarUrl?: string;
  role?: string;
  isActive?: boolean;
  password?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<{
      id: number; email: string; password_hash: string | null;
      first_name: string | null; last_name: string | null; age: number | null;
      avatar_url: string | null; role: string; is_active: boolean; created_at: Date;
    }>('SELECT * FROM users WHERE email = $1', [email]);
    if (!rows[0]) return null;
    return this.rowToRecord(rows[0]);
  }

  async findById(id: number): Promise<UserRecord | null> {
    const { rows } = await this.db.query<{
      id: number; email: string; password_hash: string | null;
      first_name: string | null; last_name: string | null; age: number | null;
      avatar_url: string | null; role: string; is_active: boolean; created_at: Date;
    }>('SELECT * FROM users WHERE id = $1', [id]);
    if (!rows[0]) return null;
    return this.rowToRecord(rows[0]);
  }

  async list(): Promise<UserDto[]> {
    const { rows } = await this.db.query<{
      id: number; email: string; first_name: string | null;
      last_name: string | null; age: number | null; avatar_url: string | null;
      role: string; is_active: boolean;
    }>('SELECT id, email, first_name, last_name, age, avatar_url, role, is_active FROM users ORDER BY id');
    return rows.map((r) => ({
      id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name,
      age: r.age, avatarUrl: r.avatar_url, role: r.role, isActive: r.is_active,
    }));
  }

  async create(dto: CreateUserDto): Promise<UserDto> {
    const existing = await this.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already in use');
    const hash = dto.password ? await bcrypt.hash(dto.password, 10) : null;
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO users (email, password_hash, first_name, last_name, age, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [dto.email, hash, dto.firstName ?? null, dto.lastName ?? null,
       dto.age ?? null, dto.role ?? 'viewer'],
    );
    return this.toDto((await this.findById(rows[0].id))!);
  }

  async update(id: number, dto: UpdateUserDto): Promise<UserDto> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    const hash = dto.password ? await bcrypt.hash(dto.password, 10) : undefined;
    await this.db.query(
      `UPDATE users SET
         first_name    = COALESCE($1, first_name),
         last_name     = COALESCE($2, last_name),
         age           = COALESCE($3, age),
         role          = COALESCE($4, role),
         is_active     = COALESCE($5, is_active),
         password_hash = COALESCE($6, password_hash),
         avatar_url    = COALESCE($7, avatar_url),
         updated_at    = NOW()
       WHERE id = $8`,
      [
        dto.firstName ?? null, dto.lastName ?? null, dto.age ?? null,
        dto.role ?? null, dto.isActive ?? null, hash ?? null,
        dto.avatarUrl ?? null, id,
      ],
    );
    return this.toDto((await this.findById(id))!);
  }

  async remove(id: number): Promise<void> {
    const { rowCount } = await this.db.query('DELETE FROM users WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundException('User not found');
  }

  async getGrants(userId: number): Promise<AccessGrantDto[]> {
    const { rows } = await this.db.query<{
      id: number; resource_type: string; resource_id: string | null; permission: string;
    }>('SELECT id, resource_type, resource_id, permission FROM user_access_grants WHERE user_id = $1 ORDER BY id', [userId]);
    return rows.map((r) => ({
      id: r.id, resourceType: r.resource_type, resourceId: r.resource_id, permission: r.permission,
    }));
  }

  async addGrant(userId: number, dto: { resourceType: string; resourceId?: string; permission: string }): Promise<AccessGrantDto> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO user_access_grants (user_id, resource_type, resource_id, permission)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, dto.resourceType, dto.resourceId ?? null, dto.permission],
    );
    return { id: rows[0].id, resourceType: dto.resourceType, resourceId: dto.resourceId ?? null, permission: dto.permission };
  }

  async removeGrant(grantId: number): Promise<void> {
    await this.db.query('DELETE FROM user_access_grants WHERE id = $1', [grantId]);
  }

  toDto(user: UserRecord): UserDto {
    return {
      id: user.id, email: user.email, firstName: user.firstName,
      lastName: user.lastName, age: user.age, avatarUrl: user.avatarUrl,
      role: user.role, isActive: user.isActive,
    };
  }

  private rowToRecord(r: {
    id: number; email: string; password_hash: string | null;
    first_name: string | null; last_name: string | null; age: number | null;
    avatar_url: string | null; role: string; is_active: boolean; created_at: Date;
  }): UserRecord {
    return {
      id: r.id, email: r.email, passwordHash: r.password_hash,
      firstName: r.first_name, lastName: r.last_name, age: r.age,
      avatarUrl: r.avatar_url, role: r.role, isActive: r.is_active, createdAt: r.created_at,
    };
  }
}
