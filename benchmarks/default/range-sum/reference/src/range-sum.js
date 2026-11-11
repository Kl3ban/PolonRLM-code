export class RangeSum {
  #prefix;
  #length;

  constructor(values) {
    if (!Array.isArray(values)) throw new TypeError('values must be an array');
    const prefix = new Array(values.length + 1);
    prefix[0] = 0;
    for (let index = 0; index < values.length; index += 1) {
      if (!(index in values)) throw new TypeError('values must not contain holes');
      const value = values[index];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError('values must contain only finite numbers');
      }
      prefix[index + 1] = prefix[index] + value;
    }
    this.#prefix = prefix;
    this.#length = values.length;
  }

  sumRange(left, right) {
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
      throw new TypeError('indices must be safe integers');
    }
    if (this.#length === 0) throw new RangeError('the range is empty');
    if (left < 0 || right >= this.#length) throw new RangeError('index out of range');
    if (left > right) throw new RangeError('left must not exceed right');
    return this.#prefix[right + 1] - this.#prefix[left];
  }
}
