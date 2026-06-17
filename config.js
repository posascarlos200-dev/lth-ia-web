/* Configuracion publica de LTH IA Web.
   La URL y la publishable key son claves de cliente (anon/publishable): es
   seguro exponerlas. La seguridad real vive en las RLS de Supabase y en la
   edge function lth-ia-cloud (que valida el JWT del usuario). */
window.LTH_IA_CONFIG = {
  SUPABASE_URL: 'https://dupdiecesnyjowfvjjre.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_FakV4csGijIOhyLtZKdjJw_hmfjH4vo',
  FUNCTION_PATH: '/functions/v1/lth-ia-cloud',
  APP_NAME: 'LTH IA',
  ASSISTANT_NAME: 'Mady'
};
