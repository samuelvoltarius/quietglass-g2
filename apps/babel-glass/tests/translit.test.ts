import { describe, it, expect } from "vitest";
import { guessCyrillicLanguage, hasCyrillic, transliterate } from "../src/text/translit";

describe("Russian transliteration", () => {
  it("covers the whole alphabet", () => {
    expect(transliterate("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "ru"))
      .toBe("abvgdeyozhziyklmnoprstufkhtschshshch\"y'eyuya");
  });

  it("handles the letters the task singles out", () => {
    expect(transliterate("ёж", "ru")).toBe("yozh");
    expect(transliterate("май", "ru")).toBe("may");
    expect(transliterate("щи", "ru")).toBe("shchi");
    expect(transliterate("подъезд", "ru")).toBe("pod\"ezd");
    expect(transliterate("день", "ru")).toBe("den'");
    expect(transliterate("мы", "ru")).toBe("my");
    expect(transliterate("это", "ru")).toBe("eto");
    expect(transliterate("юла", "ru")).toBe("yula");
    expect(transliterate("я", "ru")).toBe("ya");
  });

  it("transliterates a sentence and keeps punctuation", () => {
    expect(transliterate("Привет, как дела?", "ru")).toBe("Privet, kak dela?");
    expect(transliterate("Щука и Ёлка", "ru")).toBe("Shchuka i Yolka");
  });

  it("keeps all-caps words all caps", () => {
    expect(transliterate("ЩИ", "ru")).toBe("SHCHI");
    expect(transliterate("МОСКВА ЖДЁТ", "ru")).toBe("MOSKVA ZHDYOT");
    expect(transliterate("Я", "ru")).toBe("Ya");
  });

  it("leaves Latin text, digits and German untouched", () => {
    expect(transliterate("Grüße 2026", "ru")).toBe("Grüße 2026");
    expect(transliterate("Привет Grüße", "ru")).toBe("Privet Grüße");
  });
});

describe("Belarusian transliteration", () => {
  it("covers the alphabet, including ў, і and г", () => {
    expect(transliterate("абвгдеёжзійклмнопрстуўфхцчшыьэюя", "be"))
      .toBe("abvhdeyozhziyklmnoprstuufkhtschshy'eyuya");
  });

  it("transliterates real sentences", () => {
    expect(transliterate("Добры дзень, як справы?", "be")).toBe("Dobry dzen', yak spravy?");
    expect(transliterate("Беларусь", "be")).toBe("Belarus'");
    expect(transliterate("Мінск", "be")).toBe("Minsk");
    expect(transliterate("Гродна", "be")).toBe("Hrodna");
    expect(transliterate("воўк", "be")).toBe("vouk");
  });

  it("renders the apostrophe as a separator, in all its spellings", () => {
    expect(transliterate("сям'я", "be")).toBe("syam\"ya");
    expect(transliterate("сям’я", "be")).toBe("syam\"ya");
    expect(transliterate("сямʼя", "be")).toBe("syam\"ya");
  });

  it("keeps an apostrophe that is just punctuation", () => {
    expect(transliterate("'Мінск'", "be")).toBe("'Minsk'");
  });

  it("uses g for г in Russian but h in Belarusian", () => {
    expect(transliterate("город", "ru")).toBe("gorod");
    expect(transliterate("горад", "be")).toBe("horad");
  });
});

describe("Ukrainian transliteration", () => {
  it("maps the letters that differ from Russian", () => {
    expect(transliterate("Київ", "uk")).toBe("Kyyiv");
    expect(transliterate("Привіт, як справи?", "uk")).toBe("Pryvit, yak spravy?");
    expect(transliterate("єдність ґанок", "uk")).toBe("yednist' ganok");
  });
});

describe("table choice", () => {
  it("guesses the orthography from letters only one alphabet has", () => {
    expect(guessCyrillicLanguage("Прывітанне ўсім")).toBe("be");
    expect(guessCyrillicLanguage("Мінск")).toBe("be");
    expect(guessCyrillicLanguage("Київ")).toBe("uk");
    expect(guessCyrillicLanguage("Привіт, як справи?")).toBe("uk");
    expect(guessCyrillicLanguage("Привет")).toBe("ru");
  });

  it("guesses when the language is auto, unknown or region-tagged", () => {
    expect(transliterate("Гродна і Мінск", "auto")).toBe("Hrodna i Minsk");
    expect(transliterate("Гродна і Мінск")).toBe("Hrodna i Minsk");
    expect(transliterate("Горад", "be-BY")).toBe("Horad");
  });

  it("detects Cyrillic", () => {
    expect(hasCyrillic("abc")).toBe(false);
    expect(hasCyrillic("abc ў")).toBe(true);
  });

  it("produces ASCII only for Cyrillic input", () => {
    const out = transliterate("Шчасліва! Ўсё добра. Щедрый подъём, Юля, Эля, мясо, чай", "auto");
    expect(/^[\x20-\x7E]*$/.test(out)).toBe(true);
  });
});
