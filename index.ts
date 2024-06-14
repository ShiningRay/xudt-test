import { addressToScript, getTransactionSize } from '@nervosnetwork/ckb-sdk-utils';
import {
  getSecp256k1CellDep,
  RgbppTokenInfo,
  NoLiveCellError,
  calculateUdtCellCapacity,
  MAX_FEE,
  MIN_CAPACITY,
  append0x,
  u128ToLe,
  SECP256K1_WITNESS_LOCK_SIZE,
  calculateTransactionFee,
  NoXudtLiveCellError,
  fetchTypeIdCellDeps,
} from '@rgbpp-sdk/ckb';
import { CKB_PRIVATE_KEY, ckbAddress, collector, isMainnet } from './env';

interface XudtTransferParams {
  xudtType: CKBComponents.Script;
  receivers: {
    toAddress: string;
    transferAmount: bigint;
  }[];
}
const txFee = BigInt(3000) * BigInt(10 ** 8)

/**
 * transferXudt can be used to mint xUDT assets or transfer xUDT assets.
 * @param xudtType The xUDT type script that comes from 1-issue-xudt
 * @param receivers The receiver includes toAddress and transferAmount
 */
const transferXudt = async (xudtType: CKBComponents.Script, xudtAmount: bigint, ckbAmount: bigint, toAddress: string) => {
  const fromLock = addressToScript(ckbAddress);
  const toLock = addressToScript(toAddress);
  const xudtCells = await collector.getCells({
    lock: fromLock,
    type: xudtType,
  });


  if (!xudtCells || xudtCells.length === 0) {
    throw new NoXudtLiveCellError('The address has no xudt cells');
  }

  let sumXudtOutputCapacity = calculateUdtCellCapacity(toLock);

  const ckbOutput = {
    lock: toLock,
    capacity: append0x(ckbAmount.toString(16)),
  }
  let sumOutputCapacity = sumXudtOutputCapacity + ckbAmount
  const {
    inputs: udtInputs,
    sumInputsCapacity: sumXudtInputsCapacity,
    sumAmount,
  } = collector.collectUdtInputs({
    liveCells: xudtCells,
    needAmount: xudtAmount,
  });


  let actualInputsCapacity = sumXudtInputsCapacity;
  let inputs = udtInputs
  const outputs: CKBComponents.CellOutput[] = []
  const xudtOutput = {
    lock: toLock,
    type: xudtType,
    capacity: append0x(calculateUdtCellCapacity(toLock).toString(16)),
  }
  outputs.push(xudtOutput)
  outputs.push(ckbOutput)
  const outputsData = [append0x(u128ToLe(xudtAmount)), '0x'];

  if (sumAmount > xudtAmount) { // we have xudt changes
    const remainXudtAmount = sumAmount - xudtAmount
    const capacity = calculateUdtCellCapacity(fromLock)
    const remainXudtOutput = {
      lock: fromLock,
      type: xudtType,
      capacity: append0x(capacity.toString(16)),
    }
    outputs.push(remainXudtOutput)
    outputsData.push(append0x(u128ToLe(remainXudtAmount)))
    sumOutputCapacity += capacity
  }
  let remainCkb = actualInputsCapacity - sumOutputCapacity - txFee

  if (remainCkb >= 0) {// we don't need extra ckb cells
    if (remainCkb > 65_0000_0000) {
      outputs.push({
        lock: fromLock,
        capacity: append0x(remainCkb.toString(16)),
      })
      outputsData.push('0x')
    } else {
      ckbOutput.capacity = append0x((ckbAmount + remainCkb).toString(16))
    }
    const unsignedTx = {
      version: '0x0',
      cellDeps: [getSecp256k1CellDep(isMainnet), ...(await fetchTypeIdCellDeps(isMainnet, { xudt: true }))],
      headerDeps: [],
      inputs,
      outputs,
      outputsData,
      witnesses: inputs.map(() => '0x'),
    };
    const signedTx = collector.getCkb().signTransaction(CKB_PRIVATE_KEY)(unsignedTx);
    const txHash = await collector.getCkb().rpc.sendTransaction(signedTx, 'passthrough');

    console.info(`CKB asset has been transferred and tx hash is ${txHash}`);
    return;
  }

  // we need extra free ckb cells to transfer
  let freeCells = await collector.getCells({
    lock: fromLock,
    isDataMustBeEmpty: true,
  });
  freeCells = freeCells.filter((cell) => !cell.output.type);

  if (!freeCells || freeCells.length === 0) {
    throw new NoXudtLiveCellError('The address has no free cells');
  }
  const freeCapacityNeeded = -remainCkb
  const {
    inputs: freeInputs,
    sumInputsCapacity: sumFreeCapacity,
  } = collector.collectInputs(
    freeCells,
    BigInt(freeCapacityNeeded),
    BigInt(0)
  );
  inputs = inputs.concat(freeInputs)
  actualInputsCapacity += sumFreeCapacity
  remainCkb = actualInputsCapacity - sumOutputCapacity - txFee

  outputs.push({
    lock: fromLock,
    capacity: append0x(remainCkb.toString(16)),
  });
  outputsData.push('0x');

  const emptyWitness = { lock: '', inputType: '', outputType: '' };
  const witnesses = inputs.map((_, index) => (index === 0 ? emptyWitness : '0x'));

  const cellDeps = [getSecp256k1CellDep(isMainnet), ...(await fetchTypeIdCellDeps(isMainnet, { xudt: true }))];

  const unsignedTx = {
    version: '0x0',
    cellDeps,
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses,
  };

  const signedTx = collector.getCkb().signTransaction(CKB_PRIVATE_KEY)(unsignedTx);
  const txHash = await collector.getCkb().rpc.sendTransaction(signedTx, 'passthrough');

  console.info(`xUDT asset has been minted or transferred and tx hash is ${txHash}`);
};

const XUDT_TOKEN_INFO: RgbppTokenInfo = {
  decimal: 8,
  name: 'XUDT Test Token',
  symbol: 'XTT',
};

transferXudt(
  // The xudtType comes from 1-issue-xudt
  {
    "codeHash": "0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb",
    "args": "0xbd23085b46a45fdeaf08010bc3b65b657e3175624258183cd279e866353e31f3",
    "hashType": "type"
  },
  BigInt(1000) * BigInt(10 ** XUDT_TOKEN_INFO.decimal),
  BigInt(1000) * BigInt(10 ** 8),
  'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxs09mzapj59hfgrjk62d6mffawj4dyafygvehhc'
);
