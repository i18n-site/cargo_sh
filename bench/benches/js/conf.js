import { join, basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import read from "@3-/read";
import { tmpdir } from "node:os";
import write from "@3-/write";

export const PWD = import.meta.dirname,
  ROOT = dirname(dirname(PWD)),
  NAME = Bun.TOML.parse(read(join(ROOT, "Cargo.toml"))).package.name,
  BENCH_JSON_PATH = join(tmpdir(), NAME + ".bench.json"),
  DIR_I18N = join(PWD, "i18n"),
  LANG = (process.env.LANG || "").split("_")[0],
  i18nFile = (file) => {
    const fp = join(DIR_I18N, LANG, file);
    if (existsSync(fp)) {
      return fp;
    }
    return join(DIR_I18N, "en", file);
  },
  DIR_README = join(ROOT, "readme"),
  i18nLi = (name) =>
    ["en", "zh"].map((lang) => [lang, join(DIR_I18N, lang, name)]),
  readmeWrite = (meta, filename, render) =>
    i18nLi(basename(meta.filename)).map(async ([lang, fp]) => {
      write(join(DIR_README, lang, filename), render(await import(fp), lang));
    }),
  i18nImport = (meta) => import(i18nFile(basename(meta.filename))),
  benchJsonLi = () =>
    existsSync(BENCH_JSON_PATH)
      ? read(BENCH_JSON_PATH).trimEnd().split("\n").map(JSON.parse)
      : [];
