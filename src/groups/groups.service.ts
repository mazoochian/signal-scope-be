import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { CreateGroupDto, UpdateGroupDto } from './dto/group.dto';

export interface GroupDto {
  id: number;
  name: string;
  description: string | null;
  role: string;
  memberCount: number;
  createdAt: Date;
}

export interface GroupMemberDto {
  userId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export { CreateGroupDto, UpdateGroupDto };

@Injectable()
export class GroupsService {
  constructor(private readonly db: DbService) {}

  async list(): Promise<GroupDto[]> {
    const { rows } = await this.db.query<{
      id: number; name: string; description: string | null;
      role: string; member_count: string; created_at: Date;
    }>(`
      SELECT g.id, g.name, g.description, g.role, g.created_at,
             COUNT(gm.user_id)::text AS member_count
      FROM groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      GROUP BY g.id
      ORDER BY g.id
    `);
    return rows.map((r) => ({
      id: r.id, name: r.name, description: r.description, role: r.role,
      memberCount: parseInt(r.member_count, 10), createdAt: r.created_at,
    }));
  }

  async create(dto: CreateGroupDto): Promise<GroupDto> {
    const existing = await this.db.query('SELECT id FROM groups WHERE name = $1', [dto.name]);
    if (existing.rows.length > 0) throw new ConflictException('Group name already in use');
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO groups (name, description, role) VALUES ($1, $2, $3) RETURNING id`,
      [dto.name, dto.description ?? null, dto.role ?? 'viewer'],
    );
    return this.findById(rows[0].id) as Promise<GroupDto>;
  }

  async update(id: number, dto: UpdateGroupDto): Promise<GroupDto> {
    const group = await this.findById(id);
    if (!group) throw new NotFoundException('Group not found');
    await this.db.query(
      `UPDATE groups SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         role        = COALESCE($3, role),
         updated_at  = NOW()
       WHERE id = $4`,
      [dto.name ?? null, dto.description ?? null, dto.role ?? null, id],
    );
    return this.findById(id) as Promise<GroupDto>;
  }

  async remove(id: number): Promise<void> {
    const { rowCount } = await this.db.query('DELETE FROM groups WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundException('Group not found');
  }

  async findById(id: number): Promise<GroupDto | null> {
    const { rows } = await this.db.query<{
      id: number; name: string; description: string | null;
      role: string; member_count: string; created_at: Date;
    }>(`
      SELECT g.id, g.name, g.description, g.role, g.created_at,
             COUNT(gm.user_id)::text AS member_count
      FROM groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      WHERE g.id = $1
      GROUP BY g.id
    `, [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id, name: r.name, description: r.description, role: r.role,
      memberCount: parseInt(r.member_count, 10), createdAt: r.created_at,
    };
  }

  async listMembers(groupId: number): Promise<GroupMemberDto[]> {
    const group = await this.findById(groupId);
    if (!group) throw new NotFoundException('Group not found');
    const { rows } = await this.db.query<{
      user_id: number; email: string; first_name: string | null; last_name: string | null;
    }>(`
      SELECT u.id AS user_id, u.email, u.first_name, u.last_name
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
      ORDER BY u.id
    `, [groupId]);
    return rows.map((r) => ({
      userId: r.user_id, email: r.email, firstName: r.first_name, lastName: r.last_name,
    }));
  }

  async addMember(groupId: number, userId: number): Promise<void> {
    const group = await this.findById(groupId);
    if (!group) throw new NotFoundException('Group not found');
    await this.db.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, userId],
    );
  }

  async removeMember(groupId: number, userId: number): Promise<void> {
    await this.db.query(
      'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId],
    );
  }
}
