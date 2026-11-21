// A transferência atendida não segura a vaga do teto de ligações recebidas (achado do Verificador no
// #543). A vaga é da conversa com a IA: quando a pessoa da equipe atende, a conversa com o agente
// acabou, e a próxima ligação não pode receber ocupado por causa da conversa dela com a pessoa.
//
// O cenário é o de produção: a ligação nasce pelo `handleInbound`, a conversa roda sobre o transporte
// do Asterisk (com a ARI falsa) e a resposta da pessoa chega pelo evento `Dial` com `ANSWER`. A linha
// da ligação continua `in_progress` e sem `ended_at` enquanto o canal está de pé — o `finish` roda uma
// vez só no fim (contrato 3 do PR) —, mas ela deixa de contar no teto.
import { INBOUND_LIMIT_SETTING } from "@deskvoice/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openTestDbs } from "../../../packages/core/test/helpers";
import { putSetting, tasksOf } from "../../../packages/tools/test/helpers";
import type { AriChannel } from "./ari";
import type { AudioSocketCloseReason, AudioSocketConnection } from "./audiosocket";
import { AsteriskCalls } from "./asterisk-transport";
import { startCallSession, type CallSession } from "./call-session";
import { handleInbound } from "./inbound";
import { callOf, callsOf, createAgent, createOrganization, createPhoneNumber, createTrunk, fakeAri, kindsOf, manualEngine, sessionHarness, type ManualEngine, type SessionHarness } from "./testing/db";
import { waitFor } from "./testing/helpers";

const { app, owner } = openTestDbs();
let harness: SessionHarness | undefined;

afterEach(async () => {
  await harness?.approvals.close();
  harness = undefined;
});
afterAll(async () => {
  await app.close();
  await owner.close();
});

const EXTEN = "553133334444";
const NUMBER = `+${EXTEN}`;
const DESTINO = `+${"551133334444"}`;
const PEDIDO = { reason: "quer falar com o financeiro", summary: "Quer a segunda via do boleto de outubro." };
/** O UUID do AudioSocket do trecho de volta (o dialplan o recebe no `setVariable`). */
const VOLTA = "7f1c3a52-6a4e-4a7b-9f0e-5d2c1b0a9e88";

const canal = (trunkId: string, id: string, exten = "553133334444"): AriChannel => ({ id, name: `PJSIP/trunk-${trunkId}-0000002a`, dialplan: { exten }, caller: { number: "31999998888" } });

/** Uma conexão de AudioSocket que o teste fecha e alimenta, como a ARI falsa não tem áudio. */
interface FakeConnection extends AudioSocketConnection {
  closedLocally: boolean;
  remoteClose(): void;
}

function conexao(id: string): FakeConnection {
  const closes: Array<(reason: AudioSocketCloseReason) => void> = [];
  const connection: FakeConnection = {
    id,
    closedLocally: false,
    onAudio: () => undefined,
    onDtmf: () => undefined,
    onClose: (handler) => void closes.push(handler),
    sendAudio: () => undefined,
    clearAudio: () => undefined,
    spokenMs: () => 0,
    sendTone: () => Promise.resolve(),
    drained: async () => undefined,
    close: () => {
      connection.closedLocally = true;
      for (const handler of closes.splice(0)) handler("local");
    },
    remoteClose: () => {
      for (const handler of closes.splice(0)) handler("hangup");
    },
  };
  return connection;
}

interface Cena {
  organizationId: string;
  trunkId: string;
  callId: string;
  channelId: string;
  calls: AsteriskCalls;
  manual: ManualEngine;
  session: CallSession;
  conexao: FakeConnection;
  harness: SessionHarness;
}

/**
 * Organização com o teto em 1, a linha e o agente com número de transferência. A primeira ligação
 * chega de verdade pelo `handleInbound`, e a conversa começa no AudioSocket que o Asterisk abriria.
 */
async function cena(label: string, options: { voltaAoAgente: boolean }): Promise<Cena> {
  const organizationId = await createOrganization(app, label);
  const agentId = await createAgent(app, organizationId, {
    engine: "manual",
    greeting: "Bom dia.",
    transferTo: DESTINO,
    tools: ["transfer_to_human"],
    transferReturnsToAgent: options.voltaAoAgente,
  });
  const trunkId = await createTrunk(app, organizationId);
  await createPhoneNumber(app, organizationId, trunkId, NUMBER, agentId);
  await putSetting(app, organizationId, INBOUND_LIMIT_SETTING, 1, false);

  const manual = manualEngine({ keyless: true });
  await harness?.approvals.close();
  harness = await sessionHarness(app, [manual.engine]);
  const clock = harness.clock;
  const ari = fakeAri();
  const calls = new AsteriskCalls({ ari, db: app, clock, log: () => undefined, newAudioId: () => VOLTA });
  const channelId = "canal-1";
  await handleInbound({ db: app, ari, clock, calls, log: () => undefined }, canal(trunkId, channelId));
  const [first] = await callsOf(app, organizationId);
  if (!first) throw new Error("the inbound call was not created");
  const conexaoDaChamada = conexao(first.id);
  const attached = calls.attach(conexaoDaChamada);
  if (!attached) throw new Error("the audio socket did not attach");
  const session = startCallSession(harness.deps, { organizationId, callId: first.id, agentId, transport: attached.transport });
  await waitFor(() => manual.configs.length === 1, "the engine to open");
  await waitFor(async () => (await kindsOf(app, first.id)).includes("call_answered"), "the call to be answered");
  return { organizationId, trunkId, callId: first.id, channelId, calls, manual, session, conexao: conexaoDaChamada, harness };
}

/** O agente pede a transferência, e o motor fecha: a partir daqui a ligação é da discagem. */
async function pedeTransferencia(daCena: Cena): Promise<void> {
  daCena.manual.emit("toolCall", { id: "t-transfer", name: "transfer_to_human", args: PEDIDO });
  await waitFor(() => daCena.manual.closed === 1, "the engine to close for the transfer");
}

/** O canal voltou do AudioSocket e o dialplan recebeu a transferência: a discagem saiu. */
async function disca(daCena: Cena): Promise<void> {
  await waitFor(() => daCena.conexao.closedLocally, "the audio socket to close for the transfer");
  await daCena.calls.afterAudio(daCena.channelId);
}

/** Outra ligação para a mesma linha: é o teto de 1 que decide, e o log da ARI diz o que aconteceu. */
async function ligaDeNovo(daCena: Cena, channelId = "canal-2"): Promise<string[]> {
  const ari = fakeAri();
  const calls = new AsteriskCalls({ ari, db: app, clock: daCena.harness.clock, log: () => undefined });
  await handleInbound({ db: app, ari, clock: daCena.harness.clock, calls, log: () => undefined }, canal(daCena.trunkId, channelId));
  return ari.log;
}

/** A última coisa que a ARI fez com a ligação: aceita (`continue`) ou ocupada (`hangup busy`). */
const ultima = (log: string[]): string | undefined => log.at(-1);
const BUSY = (channelId = "canal-2"): string => `hangup ${channelId} busy`;
const ACEITA = (channelId = "canal-2"): string => `continue ${channelId} deskvoice-audio,s`;

describe("teto de ligações recebidas com transferência", { timeout: 120_000 }, () => {
  it("chave ligada: atendida, a vaga volta para a próxima ligação, e a linha continua viva até o fim da conversa", async () => {
    const daCena = await cena("transfer-limit-answered", { voltaAoAgente: true });
    await pedeTransferencia(daCena);
    await disca(daCena);

    // Enquanto toca, a ligação é da discagem: ela conta, e a próxima recebe ocupado.
    expect(ultima(await ligaDeNovo(daCena))).toBe(BUSY());

    // A pessoa da equipe atendeu: a conversa com a IA acabou aqui.
    await daCena.calls.transferDialed(daCena.channelId, "ANSWER");

    // A vaga volta: a ligação seguinte é atendida pelo agente, com o teto de 1 ligação simultânea.
    expect(ultima(await ligaDeNovo(daCena))).toBe(ACEITA());

    // A linha da ligação transferida continua viva e honesta: o canal está de pé, o `finish` ainda não
    // rodou, e o `ended_at` só aparece no fim de verdade — que é único.
    expect(await callOf(app, daCena.callId)).toMatchObject({ status: "in_progress", end_reason: null, ended_at: null });

    await daCena.calls.channelDestroyed(daCena.channelId, "Normal Clearing");
    expect(await daCena.session.done).toMatchObject({ status: "transferred", endReason: "transferred" });
    expect(await callOf(app, daCena.callId)).toMatchObject({ status: "transferred", end_reason: "transferred", ended_at: expect.any(Date) });
    const kinds = await kindsOf(app, daCena.callId);
    expect(kinds.filter((kind) => kind === "call_ended")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "transfer_returned")).toHaveLength(0);
    expect((await tasksOf(app, daCena.organizationId)).filter((task) => task.kind === "summarize_call")).toHaveLength(1);
  });

  it("chave desligada: a transferência encerra na hora, sem trecho de volta, e a vaga também volta", async () => {
    const daCena = await cena("transfer-limit-off", { voltaAoAgente: false });
    await pedeTransferencia(daCena);
    expect(await daCena.session.done).toMatchObject({ status: "transferred", endReason: "transferred" });
    expect(await callOf(app, daCena.callId)).toMatchObject({ status: "transferred", end_reason: "transferred", ended_at: expect.any(Date) });

    // Sem volta: o motor não reabre, e a próxima ligação é atendida.
    expect(daCena.manual.configs).toHaveLength(1);
    expect(ultima(await ligaDeNovo(daCena))).toBe(ACEITA());
  });

  it("chave ligada e ninguém atendeu: a volta ao agente continua, e a vaga é da conversa de novo", async () => {
    const daCena = await cena("transfer-limit-returned", { voltaAoAgente: true });
    await pedeTransferencia(daCena);
    await disca(daCena);
    expect(ultima(await ligaDeNovo(daCena))).toBe(BUSY());

    await daCena.calls.transferEnded(daCena.channelId, "NOANSWER");
    const retorno = conexao(VOLTA);
    expect(daCena.calls.resume(retorno)).toBe(true);
    await waitFor(() => daCena.manual.configs.length === 2, "the return leg to open");
    expect(daCena.manual.configs[1]?.instructions).toContain("não foi atendida (NOANSWER)");

    // O trecho de volta é uma conversa com a IA outra vez: ele segura a vaga, e a próxima recebe ocupado.
    expect(ultima(await ligaDeNovo(daCena))).toBe(BUSY());
    expect(await callOf(app, daCena.callId)).toMatchObject({ status: "in_progress", ended_at: null });

    // Quem ligou desligou no trecho de volta: o fim é o de sempre, e a vaga fica livre.
    retorno.remoteClose();
    expect(await daCena.session.done).toMatchObject({ status: "completed", endReason: "caller_hangup" });
    expect(await callOf(app, daCena.callId)).toMatchObject({ status: "completed", end_reason: "caller_hangup", ended_at: expect.any(Date) });
  });
});
