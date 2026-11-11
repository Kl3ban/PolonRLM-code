export class RangeSum {
  constructor(values) {
    this.values = values;
  }

  sumRange(left, right) {
    let total = 0;
    for (let index = 0; index <= right; index += 1) {
      total += this.values[index];
    }
    return total;
  }
}
