// Map that reports every changed entry; used for status maps that derived views depend on.
export class ObservedMap extends Map {
  onChange = null;

  set(key, value) {
    const changed = super.get(key) !== value;
    super.set(key, value);
    if (changed) this.onChange?.(key);
    return this;
  }

  delete(key) {
    const had = super.delete(key);
    if (had) this.onChange?.(key);
    return had;
  }
}
