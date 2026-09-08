import { Link } from 'react-router-dom';

const FEATURES = [
  {
    icon: '◈',
    title: 'Il répond à partir de vos documents',
    body: "Déposez vos tarifs, horaires et règlements. L'assistant y puise ses réponses et ne dit rien qui n'y figure pas.",
  },
  {
    icon: '⚑',
    title: "Il admet quand il ne sait pas",
    body: "Plutôt que d'inventer, il vous transmet la question et prévient le client qu'une réponse arrive. Vous répondez, il apprend.",
  },
  {
    icon: '⌘',
    title: 'Il parle comme vos clients',
    body: 'Français, anglais, arabe et arabizi. Il détecte la langue à chaque message et répond dans la même.',
  },
  {
    icon: '◐',
    title: 'Sur vos canaux',
    body: 'Widget sur votre site, Messenger, Instagram, WhatsApp. Une seule base de connaissance derrière.',
  },
  {
    icon: '▦',
    title: 'Vous voyez tout',
    body: 'Conversations, taux de résolution, temps de réponse. Et surtout : les questions auxquelles vos documents ne répondent pas.',
  },
  {
    icon: '✦',
    title: 'Vous le testez quand vous voulez',
    body: "Un espace d'essai dans votre console, sans fausser vos statistiques.",
  },
];

export function Landing() {
  return (
    <div>
      <nav className="lp-nav">
        <div className="brand" style={{ padding: 0 }}><span className="mark">◆</span> Assistant</div>
        <div className="links">
          <a href="#fonctionnement">Fonctionnement</a>
          <a href="#pourquoi">Pourquoi</a>
          <Link className="btn" to="/login">Se connecter</Link>
        </div>
      </nav>

      <header className="hero">
        <div>
          <span className="eyebrow">● Assistant client, branché sur vos documents</span>
          <h1>Vos clients posent<br />des questions.<br />Il y répond.</h1>
          <p className="lead">
            Un assistant qui connaît vos tarifs, vos horaires et vos règles parce qu'il les a lus.
            Il répond en quelques secondes, dans la langue de votre client — et vous passe la main
            quand il ne sait pas, au lieu d'inventer.
          </p>
          <div className="hero-actions">
            <Link className="btn big" to="/login">Se connecter</Link>
            <a className="btn ghost big" href="#fonctionnement">Voir comment ça marche</a>
          </div>
        </div>

        <div className="demo">
          <div className="head"><span className="live" /> Conversation en direct</div>
          <div className="msg m-user">b9adeh les abonnements ?</div>
          <div className="msg m-assistant">
            Standard : 89 TND fil chhar, bla engagement.{'\n'}
            Premium : 139 TND fil chhar, 3 chhourat minimum.{'\n'}
            Étudiant : 69 TND fil chhar.
            <div className="meta">2,9 s · pertinence 0.68</div>
          </div>
          <div className="msg m-user">w les horaires ?</div>
          <div className="msg m-assistant">
            Men l'itnin lel jom3a : 06:00 – 22:30. Essabt : 08:00 – 20:00.
            <div className="meta">2,1 s · pertinence 0.74</div>
          </div>
        </div>
      </header>

      <section className="strip">
        <div className="stat"><b>&lt; 3 s</b><span className="sub">temps de réponse médian</span></div>
        <div className="stat"><b>4 langues</b><span className="sub">dont l'arabizi tunisien</span></div>
        <div className="stat"><b>24 h/24</b><span className="sub">y compris la nuit et les jours fériés</span></div>
        <div className="stat"><b>0 invention</b><span className="sub">il ne dit que ce qu'il a lu</span></div>
      </section>

      <section className="features" id="fonctionnement">
        <h2>Ce qu'il fait</h2>
        <p className="sub" style={{ fontSize: 15 }}>
          Pas un chatbot à scénarios. Un assistant qui lit vos documents et répond avec.
        </p>
        <div className="grid3">
          {FEATURES.map((f) => (
            <div className="card feat" key={f.title}>
              <div className="ic">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="features" id="pourquoi" style={{ paddingTop: 0 }}>
        <h2>Ce qui change vraiment</h2>
        <div className="grid3" style={{ marginTop: 24 }}>
          <div className="card feat">
            <h3>Il ne raconte pas n'importe quoi</h3>
            <p>
              La plupart des assistants inventent quand ils ne savent pas. Celui-ci se tait et vous
              transmet la question. C'est moins spectaculaire, et beaucoup plus sûr pour votre image.
            </p>
          </div>
          <div className="card feat">
            <h3>Vous découvrez ce qui vous manque</h3>
            <p>
              Chaque question sans réponse est enregistrée et comptée. Vous voyez noir sur blanc les
              informations que vos clients réclament et que vous n'avez jamais écrites nulle part.
            </p>
          </div>
          <div className="card feat">
            <h3>Vos réponses lui servent</h3>
            <p>
              Quand vous répondez à une question transmise, elle rejoint la conversation du client —
              et peut enrichir sa base pour la fois suivante. Vous décidez au cas par cas.
            </p>
          </div>
        </div>
      </section>

      <section className="cta">
        <h2>Votre assistant vous attend</h2>
        <p>Connectez-vous à votre espace pour voir ce qu'il a répondu aujourd'hui.</p>
        <Link className="btn big" to="/login">Se connecter</Link>
      </section>

      <footer className="foot">
        <span>© {new Date().getFullYear()} Assistant</span>
        <span style={{ marginLeft: 'auto' }}>
          <Link to="/login">Espace client</Link>
        </span>
      </footer>
    </div>
  );
}
