import { describe, expect, it } from "vitest";
import { parseCustomerName, sameCustomerName } from "../src/voice/customer-voice";

describe("a new customer by voice", () => {
  it("takes the name out of what was said, in German and English", () => {
    expect(parseCustomerName("Neuer Kunde Anna Beispiel.")).toBe("Anna Beispiel");
    expect(parseCustomerName("neuen Kunden anlegen namens bäckerei sonnenschein")).toBe("Bäckerei Sonnenschein");
    expect(parseCustomerName("Der Kunde heißt Studio Nordlicht")).toBe("Studio Nordlicht");
    expect(parseCustomerName("new customer called Sunshine Bakery!")).toBe("Sunshine Bakery");
    expect(parseCustomerName("The client is Anna Example")).toBe("Anna Example");
    expect(parseCustomerName("Muster GmbH bitte")).toBe("Muster GmbH");
    expect(parseCustomerName("„Café am Eck“")).toBe("Café am Eck");
  });

  it("keeps the spelling it was given and capitalises only all-lower-case names", () => {
    expect(parseCustomerName("Neuer Kunde ACME")).toBe("ACME");
    expect(parseCustomerName("neuer kunde jean-luc picard")).toBe("Jean-Luc Picard");
  });

  it("returns nothing when no name is left", () => {
    expect(parseCustomerName("Neuer Kunde.")).toBe("");
    expect(parseCustomerName("…")).toBe("");
    expect(parseCustomerName("   ")).toBe("");
  });

  it("recognises the same customer regardless of case, accents and spacing", () => {
    expect(sameCustomerName("Anna  Beispiel", "anna beispiel")).toBe(true);
    expect(sameCustomerName("Café Eck", "Cafe Eck")).toBe(true);
    expect(sameCustomerName("Anna", "Anne")).toBe(false);
  });
});
