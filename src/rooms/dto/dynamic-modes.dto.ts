import { IsBoolean } from 'class-validator';

/** Cuerpo de `PATCH /rooms/:roomId/dynamic-modes` (ADR-0003). */
export class SetDynamicModesDto {
  @IsBoolean({ message: 'enabled debe ser verdadero o falso.' }) enabled: boolean;
}
