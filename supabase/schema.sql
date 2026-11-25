-- ============================================================
--  Mot à Mot — schéma Supabase
--  À exécuter dans : Supabase > SQL Editor > New query > Run
-- ============================================================

-- ---------- Profils (pseudo public lié au compte) ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null check (username ~ '^[A-Za-z0-9_-]{3,20}$'),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_key on public.profiles (lower(username));

-- Création automatique du profil à l'inscription (pseudo passé dans les metadata)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'joueur_' || substr(new.id::text, 1, 6)));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Vérification de disponibilité du pseudo (appelable avant inscription)
create or replace function public.username_available(p_username text)
returns boolean language sql security definer stable set search_path = public as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(btrim(p_username)));
$$;

-- ---------- Parties ----------
create table if not exists public.games (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references public.profiles(id) on delete cascade,
  opponent_id  uuid references public.profiles(id) on delete set null,
  start_word   text not null,
  target_word  text not null,
  current_word text not null,
  current_turn uuid references public.profiles(id) on delete set null,
  status       text not null default 'waiting' check (status in ('waiting','active','finished')),
  winner_id    uuid references public.profiles(id) on delete set null,
  end_reason   text,                       -- 'target' | 'resign'
  move_count   int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (char_length(start_word) = char_length(target_word)),
  check (start_word <> target_word)
);
create index if not exists games_creator_idx  on public.games (creator_id);
create index if not exists games_opponent_idx on public.games (opponent_id);
create index if not exists games_status_idx   on public.games (status);

-- ---------- Coups ----------
create table if not exists public.moves (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  player_id  uuid not null references public.profiles(id) on delete cascade,
  word       text not null,
  created_at timestamptz not null default now()
);
create index if not exists moves_game_idx on public.moves (game_id, id);

-- ---------- Sécurité (RLS) : lecture seule côté client, écriture via fonctions ----------
alter table public.profiles enable row level security;
alter table public.games    enable row level security;
alter table public.moves    enable row level security;

revoke all on public.profiles, public.games, public.moves from anon, authenticated;
grant select on public.profiles, public.games, public.moves to authenticated;

drop policy if exists "profiles lisibles" on public.profiles;
create policy "profiles lisibles" on public.profiles
  for select to authenticated using (true);

drop policy if exists "parties visibles" on public.games;
create policy "parties visibles" on public.games
  for select to authenticated
  using (status = 'waiting' or auth.uid() in (creator_id, opponent_id));

drop policy if exists "coups visibles" on public.moves;
create policy "coups visibles" on public.moves
  for select to authenticated
  using (exists (
    select 1 from public.games g
    where g.id = moves.game_id and auth.uid() in (g.creator_id, g.opponent_id)
  ));

-- ---------- Règles du jeu ----------

-- Nombre de lettres différentes entre deux mots (-1 si longueurs différentes)
create or replace function public.word_diff(a text, b text)
returns int language plpgsql immutable as $$
declare n int := 0; i int;
begin
  if char_length(a) <> char_length(b) then return -1; end if;
  for i in 1..char_length(a) loop
    if substr(a, i, 1) <> substr(b, i, 1) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Créer une partie
create or replace function public.create_game(p_start text, p_target text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  s text := lower(btrim(p_start));
  t text := lower(btrim(p_target));
  gid uuid;
begin
  if uid is null then raise exception 'Connexion requise'; end if;
  if s !~ '^[a-zàâäçéèêëîïôöùûüÿœæ]{2,12}$' or t !~ '^[a-zàâäçéèêëîïôöùûüÿœæ]{2,12}$' then
    raise exception 'Les mots doivent contenir 2 à 12 lettres (sans espace ni chiffre)';
  end if;
  if char_length(s) <> char_length(t) then
    raise exception 'Les deux mots doivent avoir le même nombre de lettres';
  end if;
  if s = t then raise exception 'Les deux mots doivent être différents'; end if;

  insert into public.games (creator_id, start_word, target_word, current_word)
  values (uid, s, t, s) returning id into gid;
  return gid;
end $$;

-- Rejoindre une partie en attente (le créateur joue en premier)
create or replace function public.join_game(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); g public.games;
begin
  if uid is null then raise exception 'Connexion requise'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Partie introuvable'; end if;
  if g.status <> 'waiting' then raise exception 'Cette partie a déjà commencé'; end if;
  if g.creator_id = uid then raise exception 'Tu ne peux pas rejoindre ta propre partie'; end if;

  update public.games
     set opponent_id = uid, status = 'active', current_turn = g.creator_id, updated_at = now()
   where id = p_game;
end $$;

-- Jouer un coup : changer exactement une lettre
create or replace function public.play_move(p_game uuid, p_word text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  g public.games;
  w text := lower(btrim(p_word));
begin
  if uid is null then raise exception 'Connexion requise'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Partie introuvable'; end if;
  if uid not in (g.creator_id, g.opponent_id) then raise exception 'Tu ne participes pas à cette partie'; end if;
  if g.status <> 'active' then raise exception 'La partie n''est pas en cours'; end if;
  if g.current_turn is distinct from uid then raise exception 'Ce n''est pas ton tour'; end if;

  if w !~ '^[a-zàâäçéèêëîïôöùûüÿœæ]+$' then raise exception 'Lettres uniquement'; end if;
  if char_length(w) <> char_length(g.current_word) then
    raise exception 'Le mot doit faire % lettres', char_length(g.current_word);
  end if;
  if public.word_diff(w, g.current_word) <> 1 then
    raise exception 'Change exactement une lettre';
  end if;
  if w = g.start_word or exists (select 1 from public.moves where game_id = p_game and word = w) then
    raise exception 'Ce mot a déjà été utilisé dans la partie';
  end if;

  insert into public.moves (game_id, player_id, word) values (p_game, uid, w);

  if w = g.target_word then
    update public.games
       set current_word = w, move_count = move_count + 1, status = 'finished',
           winner_id = uid, end_reason = 'target', current_turn = null, updated_at = now()
     where id = p_game;
  else
    update public.games
       set current_word = w, move_count = move_count + 1,
           current_turn = case when uid = creator_id then opponent_id else creator_id end,
           updated_at = now()
     where id = p_game;
  end if;
end $$;

-- Abandonner (partie en cours) ou annuler (partie en attente, créateur)
create or replace function public.resign_game(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); g public.games;
begin
  if uid is null then raise exception 'Connexion requise'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'Partie introuvable'; end if;

  if g.status = 'waiting' then
    if g.creator_id <> uid then raise exception 'Seul le créateur peut annuler'; end if;
    delete from public.games where id = p_game;
  elsif g.status = 'active' then
    if uid not in (g.creator_id, g.opponent_id) then raise exception 'Tu ne participes pas à cette partie'; end if;
    update public.games
       set status = 'finished', end_reason = 'resign', current_turn = null, updated_at = now(),
           winner_id = case when uid = creator_id then opponent_id else creator_id end
     where id = p_game;
  else
    raise exception 'La partie est déjà terminée';
  end if;
end $$;

-- Droits d'exécution : uniquement les utilisateurs connectés (sauf vérif. du pseudo)
revoke all on function public.create_game(text, text) from public, anon;
revoke all on function public.join_game(uuid)         from public, anon;
revoke all on function public.play_move(uuid, text)   from public, anon;
revoke all on function public.resign_game(uuid)       from public, anon;
grant execute on function public.create_game(text, text) to authenticated;
grant execute on function public.join_game(uuid)         to authenticated;
grant execute on function public.play_move(uuid, text)   to authenticated;
grant execute on function public.resign_game(uuid)       to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- Temps réel ----------
alter table public.games replica identity full;   -- pour connaître l'ancien état (notifications)

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;
end $$;
