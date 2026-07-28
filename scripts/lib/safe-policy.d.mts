export type Exact2of2 = Readonly<{
  threshold: 2;
  owners: readonly string[];
}>;

export declare function assertExact2of2(input: {
  threshold: number;
  owners: readonly string[];
  ownerA: string | undefined;
  ownerB: string | undefined;
}): Exact2of2;

export declare function assertTwoSignatures(confirmations: number): 2;
