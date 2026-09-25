import { IsInt, IsPositive } from 'class-validator';
// ECICoin vale lo mismo que el peso colombiano: el monto es un entero, sin fracciones.
export class PlaceBidDto { @IsInt() @IsPositive() amount: number; }
