import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { RoomStatus } from '../../generated/prisma/client.js';

/** `?status=SCHEDULED,ACTIVE` llega como una cadena; se valida como lista. */
const commaList = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean) : value;

/**
 * Filtros de `GET /rooms`. Sin ninguno responde como siempre: las salas sin sus rondas.
 *
 * `include=rounds` trae cada sala con el mismo detalle que `GET /rooms/:id`. Es lo que
 * necesitan el listado de subastas y la portada: antes pedian el detalle sala por sala, una
 * peticion por sala cada quince segundos por cada estudiante conectado.
 */
export class ListRoomsQueryDto {
  @IsOptional()
  @IsIn(['rounds'], { message: 'include solo admite "rounds".' })
  include?: 'rounds';

  @IsOptional()
  @Transform(commaList)
  @IsEnum(RoomStatus, { each: true, message: 'status admite SCHEDULED, ACTIVE, CLOSED y CANCELLED.' })
  status?: RoomStatus[];
}
