<div align="center">
  <img src="apps/web/public/icons/ling-mark.svg" alt="Ling Stack" width="88" height="88" />
  <h1>Ling Stack</h1>
  <p><strong>Reúna seus colegas de IA em um único espaço de projeto local.</strong></p>
  <p>Escolha os modelos e mantenha conversas, aprovações de ferramentas e resultados juntos.</p>
  <p>
    <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja-JP.md">日本語</a> · <a href="README.ko-KR.md">한국어</a> ·
    <a href="README.de-DE.md">Deutsch</a> · <a href="README.fr-FR.md">Français</a> ·
    <a href="README.es-ES.md">Español</a> · Português (Brasil)
  </p>
  <p>
    <img alt="Alpha a partir do código-fonte" src="https://img.shields.io/badge/Status-source_alpha-5964a0.svg" />
    <a href="LICENSE"><img alt="Licença: MIT" src="https://img.shields.io/badge/License-MIT-08765d.svg" /></a>
    <img alt="Node.js 22.22.1+" src="https://img.shields.io/badge/Node.js-22.22.1%2B-3c873a.svg" />
    <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220.svg" />
  </p>
</div>

> [!NOTE]
> **Versão alpha com foco no uso a partir do código-fonte.** Comece pela interface Web, pelo daemon local e pela CLI.
> O ambiente de desenvolvimento Desktop está disponível separadamente. Ainda não há instaladores estáveis e assinados nem uma versão de produção com suporte.

## Comece com uma tarefa compartilhada

Ao trabalhar com vários modelos, tarefas, respostas, solicitações de ferramentas e resultados podem ficar espalhados em janelas diferentes.
O Ling Stack reúne tudo em um canal de projeto: atribua modelos e ferramentas aos colegas, acompanhe suas atividades e preserve os resultados junto com a conversa.

Experimente uma [revisão de documentos de projeto](docs/community/first-project-review.md) com escopo limitado, dois colegas e um [exemplo público](examples/project-review/README.md).
Comece pela discussão e adicione ferramentas e permissões quando uma tarefa posterior precisar delas.
Você precisa configurar seu próprio provedor e fornecer sua chave de API. Os custos do provedor são de sua responsabilidade.

![Interface em inglês do Ling Stack em um novo espaço de trabalho](docs/assets/ling-workspace-home.jpg)

Esta captura real mostra a interface em inglês de um espaço local novo, antes da configuração de um modelo.
Ela ilustra o layout, não uma tarefa concluída. Siga o guia acima para experimentar sua primeira colaboração.

## Para quem é o Ling Stack?

O Ling Stack é voltado a desenvolvedores e pessoas que usam vários modelos ou colegas de IA e querem manter o trabalho em um só lugar.
Um Model Workbench compartilhado conecta OpenAI, Anthropic, Volcengine Ark, endpoints compatíveis com DeepSeek,
MiniMax, GLM e serviços intermediários compatíveis com OpenAI.

O estado do espaço de trabalho, o histórico de conversas e as evidências de execução são armazenados localmente.
As solicitações e seu contexto, porém, são enviados aos provedores de modelos ou ferramentas que você escolher. **Armazenamento local não significa inferência offline.**
A interface oferece 55 opções de idioma e região. O idioma da interface e o das respostas da IA podem ser configurados separadamente.
O README está disponível nos oito idiomas indicados no topo. Outros documentos ainda podem estar em inglês ou chinês.

## Três formas de usar

| Cenário | O que você faz | O que fica junto |
| --- | --- | --- |
| Consultar um modelo | Configura um modelo de chat e conversa sobre um documento, uma ideia ou um projeto | Mensagens, seleção do modelo, anexos e resultados |
| Trabalhar com colegas de IA | Atribui modelos e ferramentas e colabora em um canal de projeto | Participantes, atividades das ferramentas, aprovações, artefatos e relatório final |
| Criar mídia | Configura uma capacidade de imagem ou vídeo e usa Media Production | Projetos, cenas, tarefas de geração e saídas |

Comece com uma conversa simples e adicione colegas ou ferramentas conforme a necessidade.
As skills fornecem instruções, mas não concedem automaticamente acesso a ferramentas ou arquivos.
Os agentes de programação usam o adaptador de execução Pi. As ferramentas disponíveis dependem da configuração da plataforma e da política do espaço de trabalho.

## Início rápido a partir do código-fonte

Requisitos: Git, **Node.js 22.22.1 ou superior** e **Corepack com pnpm 10**.
O repositório fixa o pnpm em `10.0.0`; a versão de referência do Node na CI é `22.22.1`.
A compilação Web/daemon também exige **Rust 1.89 ou superior e Cargo** para o sanitizador nativo de imagens.
Instale com [rustup](https://rustup.rs/); a CI usa Rust `1.97.1`.

### 1. Instalar e compilar

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

Essa compilação inclui a CLI, o daemon, o aplicativo Web e suas dependências internas. Desktop e Mobile precisam de configuração separada.

### 2. Iniciar o daemon

Na raiz do repositório, execute este comando no primeiro terminal e deixe-o em execução:

```bash
corepack pnpm ling daemon start --foreground
```

O endereço padrão é `http://127.0.0.1:17891`. Mantenha o serviço restrito ao endereço de loopback.

### 3. Abrir a interface Web

Em um segundo terminal, na mesma raiz do repositório:

```bash
corepack pnpm ling ui --foreground --open
```

Se o navegador não abrir automaticamente, acesse `http://127.0.0.1:5173`.
Em outro terminal, `curl http://127.0.0.1:17891/health` deve retornar um JSON com `"ok": true`.
Isso confirma apenas que o serviço local está funcionando, não que um modelo esteja pronto para uso.

### 4. Conectar um modelo e testar uma conversa

Abra **Settings → Model Workbench**, adicione um modelo de chat com sua própria chave de API e execute **Check**.
O primeiro modelo de chat aprovado na verificação se torna o padrão do espaço de trabalho.
Faça uma pergunta simples em uma nova conversa e examine a resposta e seus detalhes.

Depois de configurar e verificar o modelo, execute:

```bash
corepack pnpm ling doctor
```

O Doctor verifica tanto a disponibilidade do modelo quanto o estado dos serviços locais.
Um espaço novo sem modelo de chat informa uma falha do provedor mesmo quando o daemon e a interface Web estão funcionando.
O [guia de início](docs/getting-started.md) explica o primeiro modelo, a conversa e o canal de projeto. Consulte a [solução de problemas](docs/troubleshooting.md) para erros de configuração.

## Suporte e limitações

| Componente ou integração | Escopo atual |
| --- | --- |
| Web, daemon e CLI | Alpha a partir do código-fonte; caminho padrão de início |
| Electron Desktop | Ambiente de desenvolvimento; preparação da plataforma e validação em máquina limpa são etapas separadas |
| Extensão do Chrome e Browser Host | Integração de desenvolvimento local; publicação na Chrome Web Store pendente |
| MCP e Plugin Manager | Atribuição explícita de ferramentas, ativação e limites de aprovação |
| Recursos nativos de Office e Computer Use | Desenvolvimento dependente da plataforma; consulte os critérios de implementação e publicação |
| Geração de imagens e vídeos | Depende do provedor e das capacidades; alguns adaptadores reais ainda precisam de validação |
| Mobile | Desenvolvimento experimental fora do escopo atual de aceitação do produto |

Execução nativa, acessibilidade, assinatura e validação dos instaladores ainda têm etapas pendentes para certos recursos.
O [estado da implementação](docs/design/implementation-status.md) registra o que foi implementado e o que ainda precisa de validação.
Uma compilação ou um teste específico bem-sucedido não comprova que um instalador está pronto.

Para dúvidas e bugs reproduzíveis, leia o [guia de suporte](SUPPORT.md) e use os [formulários de Issues do GitHub](https://github.com/ling-stack-org/ling-stack/issues/new/choose).
A manutenção é feita conforme os recursos disponíveis. Relate vulnerabilidades pelo [canal de segurança](SECURITY.md), sem publicar dados sensíveis em issues públicas.

### Desenvolvimento Desktop

No macOS, são necessárias as Xcode Command Line Tools com Swift e `codesign`.
No Windows, o driver de Office requer o SDK do .NET 8. Os destinos atuais de distribuição são macOS arm64 e Windows x64.
O Electron também precisa do binário de sua plataforma; veja a [solução de problemas do Desktop](docs/troubleshooting.md#desktop-development).

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

Ferramentas, comandos de compilação e verificações manuais estão no [guia de pacotes de desenvolvimento para Mac e Windows](docs/release/development-packages.md).
Antes de empacotar para distribuição, leia as [regras de publicação e aceitação do Desktop](docs/release/desktop.md).
Publicar o código-fonte e distribuir binários assinados são etapas distintas.

## Dados e permissões

Os dados do espaço de trabalho ficam, por padrão, em `.ling-stack/`, incluindo `ling-stack.sqlite`, `sessions/`, `artifacts/` e `logs/`.
As chaves de API inseridas no Model Workbench são salvas no armazenamento local do espaço de trabalho.
Variáveis de ambiente e referências a chaveiros compatíveis também estão disponíveis; consulte [configuração e dados](docs/getting-started.md#configuration-and-data).

Não inclua chaves, bancos de dados, registros de sessão ou resultados privados no Git nem em relatórios públicos.
As permissões do espaço controlam acesso a arquivos, comandos shell, alterações externas e geração paga.
Revise as solicitações antes de aprová-las. Para migrar o armazenamento, use as [operações de armazenamento da CLI](docs/design/workspace-state-storage.md).

## Explorar e contribuir

Se esse fluxo de trabalho for útil, dê uma estrela ao repositório para acompanhar as atualizações.
Conte nos [formulários de Issues](https://github.com/ling-stack-org/ling-stack/issues/new/choose) o que você tentou, onde encontrou dificuldades e se o resultado ajudou.

Web (`apps/web`), Desktop (`apps/desktop`) e CLI (`packages/cli`) compartilham o daemon (`packages/daemon`).
A lógica de domínio, os contratos, os adaptadores de provedores e as integrações de execução ficam em `packages/`.

- [Guia de contribuição](CONTRIBUTING.md) e [regras de tradução dos README](CONTRIBUTING.md#readme-translations): ambiente, verificações e correções de tradução.
- [Primeira revisão de projeto](docs/community/first-project-review.md) e [materiais comunitários](docs/community/launch-kit.md): colaboração e feedback.
- [Arquitetura](docs/architecture.md) e [Daemon API](docs/daemon-api.md): limites do sistema.
- [Índice de design](docs/design/README.md) e [estado da implementação](docs/design/implementation-status.md): contratos atuais e critérios de aceitação.
- [Adaptadores de provedores](docs/provider-adapters.md) e [integração Pi](docs/pi-coding-agent-integration.md): modelos e execução.
- [Política de publicação](docs/release/README.md), [histórico de mudanças](CHANGELOG.md) e [avisos de terceiros](THIRD_PARTY_NOTICES.md).

O Ling Stack é disponibilizado sob a [licença MIT](LICENSE). A participação na comunidade segue o [código de conduta](CODE_OF_CONDUCT.md).
