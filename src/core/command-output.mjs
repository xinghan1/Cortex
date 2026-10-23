// Retain the beginning and end of a stream without retaining its middle.
// The fixed-size tail ring prevents noisy commands from growing memory use.
export class CommandOutputCapture {
  constructor(maxBytes = 32 * 1024) {
    this.head = Buffer.alloc(Math.floor(maxBytes / 2));
    this.tail = Buffer.alloc(maxBytes - this.head.length);
    this.headLength = 0;
    this.tailLength = 0;
    this.tailOffset = 0;
    this.bytes = 0;
  }

  append(chunk) {
    if (!chunk.length) return;
    this.bytes += chunk.length;
    const first = Math.min(chunk.length, this.head.length - this.headLength);
    if (first) {
      chunk.copy(this.head, this.headLength, 0, first);
      this.headLength += first;
    }
    const remaining = chunk.subarray(first);
    if (!remaining.length) return;
    if (remaining.length >= this.tail.length) {
      remaining.copy(this.tail, 0, remaining.length - this.tail.length);
      this.tailOffset = 0;
      this.tailLength = this.tail.length;
      return;
    }
    const untilEnd = Math.min(remaining.length, this.tail.length - this.tailOffset);
    remaining.copy(this.tail, this.tailOffset, 0, untilEnd);
    remaining.copy(this.tail, 0, untilEnd);
    this.tailOffset = (this.tailOffset + remaining.length) % this.tail.length;
    this.tailLength = Math.min(this.tail.length, this.tailLength + remaining.length);
  }

  snapshot() {
    const head = this.head.subarray(0, this.headLength);
    const tail = this.tailLength < this.tail.length ? this.tail.subarray(0, this.tailLength)
      : Buffer.concat([this.tail.subarray(this.tailOffset), this.tail.subarray(0, this.tailOffset)]);
    if (this.bytes <= head.length + tail.length) {
      return { text: Buffer.concat([head, tail]).toString('utf8'), bytes: this.bytes, omittedBytes: 0, truncated: false };
    }
    // Do not turn a character cut by either retention boundary into U+FFFD.
    let headEnd = head.length, lead = headEnd - 1;
    while (lead >= 0 && (head[lead] & 0xc0) === 0x80) lead--;
    if (lead >= 0) {
      const byte = head[lead];
      const size = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
      if (lead + size > headEnd) headEnd = lead;
    }
    let tailStart = 0;
    while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
    const omittedBytes = this.bytes - headEnd - (tail.length - tailStart);
    const marker = `\n[… 已省略 ${omittedBytes} 字节输出 …]\n`;
    return { text: head.subarray(0, headEnd).toString('utf8') + marker + tail.subarray(tailStart).toString('utf8'),
      bytes: this.bytes, omittedBytes, truncated: true };
  }
}
