import {
  createHttpTranslator, createOpenAiTranslator, createPassthroughTranslator,
  type TranslationProvider, type TranslationRequest,
} from "./provider";
import { translationEnabled, type BabelData } from "../storage/persist";
import { resolveSourceLanguage, sameLanguage } from "../text/languages";

/** Builds the translator the stored settings ask for. */
export function selectTranslator(
  data: BabelData,
  fetchImpl?: typeof fetch,
): TranslationProvider {
  if (!translationEnabled(data)) return createPassthroughTranslator();

  if (data.translateProvider === "openai") {
    return createOpenAiTranslator({
      url: data.llmUrl,
      model: data.llmModel,
      ...(data.llmKey ? { apiKey: data.llmKey } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  return createHttpTranslator({
    url: data.translateUrl,
    ...(data.translateKey ? { apiKey: data.translateKey } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * The request for one finished caption, or null when there is nothing to
 * translate because the caption is already in the target language.
 *
 * `detected` is the language the recogniser reported for this caption; with
 * the source set to "auto" it replaces "auto" for providers that need a real
 * code (an LLM prompt), so Belarusian is not described as "some language".
 */
export function translationRequestFor(
  data: BabelData,
  provider: TranslationProvider,
  text: string,
  detected: string | undefined,
): TranslationRequest | null {
  const from = resolveSourceLanguage(
    data.sourceLanguage,
    detected,
    provider.needsConcreteSource === true,
  );
  if (sameLanguage(from, data.targetLanguage)) return null;
  return { text, from, to: data.targetLanguage };
}
