import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";

/**
 * Minimal Merkle tree compatible with OpenZeppelin MerkleProof (sorted-pair keccak) and the StandardMerkleTree leaf
 * encoding: leaf = keccak256(bytes.concat(keccak256(abi.encode(values)))).
 * Used by the SDK's testing utilities / mock backend; production roots come from the platform backend.
 */
export function standardLeaf(types: string[], values: unknown[]): Hex {
  return keccak256(keccak256(encodeAbiParameters(types.map((t) => ({ type: t })), values as any)));
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export class SimpleMerkleTree {
  readonly leaves: Hex[];
  readonly layers: Hex[][];
  constructor(leaves: Hex[]) {
    if (!leaves.length) throw new Error("empty tree");
    this.leaves = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    const layers: Hex[][] = [this.leaves];
    while (layers[layers.length - 1].length > 1) {
      const cur = layers[layers.length - 1];
      const next: Hex[] = [];
      for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
      layers.push(next);
    }
    this.layers = layers;
  }
  get root(): Hex {
    return this.layers[this.layers.length - 1][0];
  }
  getProof(leaf: Hex): Hex[] {
    let idx = this.leaves.indexOf(leaf);
    if (idx < 0) throw new Error("leaf not in tree");
    const proof: Hex[] = [];
    for (let l = 0; l < this.layers.length - 1; l++) {
      const layer = this.layers[l];
      const sib = idx ^ 1;
      if (sib < layer.length) proof.push(layer[sib]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
  static verify(root: Hex, leaf: Hex, proof: Hex[]): boolean {
    let h = leaf;
    for (const p of proof) h = hashPair(h, p);
    return h === root;
  }
}

/** Promoter tree: leaves ["address"]. */
export function promoterTree(addresses: Hex[]) {
  const leaves = addresses.map((a) => standardLeaf(["address"], [a]));
  const tree = new SimpleMerkleTree(leaves);
  return { root: tree.root, proofOf: (a: Hex) => tree.getProof(standardLeaf(["address"], [a])) };
}

/** Reward tree: leaves ["uint256","address","uint256"] = (epoch, account, amount). */
export function rewardTree(epoch: bigint, entries: { account: Hex; amount: bigint }[]) {
  const leafOf = (e: { account: Hex; amount: bigint }) => standardLeaf(["uint256", "address", "uint256"], [epoch, e.account, e.amount]);
  const tree = new SimpleMerkleTree(entries.map(leafOf));
  return { root: tree.root, total: entries.reduce((a, e) => a + e.amount, 0n), proofOf: (e: { account: Hex; amount: bigint }) => tree.getProof(leafOf(e)) };
}
