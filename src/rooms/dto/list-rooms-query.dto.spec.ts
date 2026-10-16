import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ListRoomsQueryDto } from './list-rooms-query.dto.js';

const parse = async (query: Record<string, string>) => {
  const dto = plainToInstance(ListRoomsQueryDto, query);
  return { dto, errors: await validate(dto) };
};

describe('ListRoomsQueryDto', () => {
  it('lee status como lista separada por comas', async () => {
    const { dto, errors } = await parse({ include: 'rounds', status: 'SCHEDULED, ACTIVE' });
    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['SCHEDULED', 'ACTIVE']);
  });

  it('rechaza un estado o un include que no existen', async () => {
    expect((await parse({ status: 'ACTIVE,ABIERTA' })).errors).toHaveLength(1);
    expect((await parse({ include: 'bids' })).errors).toHaveLength(1);
  });

  it('sin parametros es valido: es el listado de siempre', async () => {
    expect((await parse({})).errors).toHaveLength(0);
  });
});
