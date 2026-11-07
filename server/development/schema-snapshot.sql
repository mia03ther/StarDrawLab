--
-- PostgreSQL database dump
--

\restrict uXTAhMI4E1TIe0g6OcZ944D4IxHvOCrMWOkvYCdHiWjZcahPHnv3ao4Ekm89BGY

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: prevent_administrator_audit_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_administrator_audit_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'administrator_audit_log is append-only';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: administrator_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.administrator_audit_log (
    id bigint NOT NULL,
    actor_user_id character varying(255) NOT NULL,
    actor_role character varying(16) NOT NULL,
    action character varying(120) NOT NULL,
    target_type character varying(80),
    target_id character varying(255),
    request_id character varying(128),
    ip_address inet,
    user_agent text,
    reason text,
    before_value jsonb,
    after_value jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT administrator_audit_log_actor_role_check CHECK (((actor_role)::text = ANY ((ARRAY['root'::character varying, 'admin'::character varying])::text[])))
);


--
-- Name: administrator_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.administrator_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: administrator_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.administrator_audit_log_id_seq OWNED BY public.administrator_audit_log.id;


--
-- Name: administrator_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.administrator_operations (
    id bigint NOT NULL,
    actor_user_id character varying(255) NOT NULL,
    actor_role character varying(16) NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    action character varying(120) NOT NULL,
    target_type character varying(80) NOT NULL,
    target_id character varying(255) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(24) DEFAULT 'claimed'::character varying NOT NULL,
    response_snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT administrator_operations_actor_role_check CHECK (((actor_role)::text = ANY ((ARRAY['root'::character varying, 'admin'::character varying])::text[]))),
    CONSTRAINT administrator_operations_completion_check CHECK (((((status)::text = 'claimed'::text) AND (response_snapshot IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'completed'::text) AND (response_snapshot IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT administrator_operations_key_check CHECK (((idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text)),
    CONSTRAINT administrator_operations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT administrator_operations_status_check CHECK (((status)::text = ANY ((ARRAY['claimed'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: administrator_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.administrator_operations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: administrator_operations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.administrator_operations_id_seq OWNED BY public.administrator_operations.id;


--
-- Name: agent_approval_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_approval_credentials (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    session_id character varying(255) NOT NULL,
    tool_key character varying(128) NOT NULL,
    parameter_digest character(64) NOT NULL,
    token_digest character(64) NOT NULL,
    status character varying(16) DEFAULT 'issued'::character varying NOT NULL,
    reason character varying(500) DEFAULT ''::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT agent_approval_parameter_digest_check CHECK ((parameter_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_approval_status_check CHECK (((status)::text = ANY ((ARRAY['issued'::character varying, 'consumed'::character varying, 'expired'::character varying, 'revoked'::character varying])::text[]))),
    CONSTRAINT agent_approval_status_times_check CHECK (((((status)::text = 'issued'::text) AND (consumed_at IS NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'consumed'::text) AND (consumed_at IS NOT NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'expired'::text) AND (consumed_at IS NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'revoked'::text) AND (consumed_at IS NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT agent_approval_token_digest_check CHECK ((token_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: agent_approval_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_approval_credentials_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_approval_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_approval_credentials_id_seq OWNED BY public.agent_approval_credentials.id;


--
-- Name: agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_conversations (
    id character varying(80) NOT NULL,
    user_id character varying(255) NOT NULL,
    surface character varying(20) NOT NULL,
    canvas_id character varying(80),
    title character varying(160) DEFAULT ''::character varying NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    runtime_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_message_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT agent_conversations_canvas_check CHECK (((((surface)::text = 'global'::text) AND (canvas_id IS NULL)) OR (((surface)::text = 'canvas'::text) AND (canvas_id IS NOT NULL)))),
    CONSTRAINT agent_conversations_id_check CHECK (((id)::text ~ '^agent_[0-9a-f-]{36}$'::text)),
    CONSTRAINT agent_conversations_messages_check CHECK ((jsonb_typeof(messages) = 'array'::text)),
    CONSTRAINT agent_conversations_runtime_check CHECK ((jsonb_typeof(runtime_state) = 'object'::text)),
    CONSTRAINT agent_conversations_surface_check CHECK (((surface)::text = ANY ((ARRAY['global'::character varying, 'canvas'::character varying])::text[])))
);


--
-- Name: agent_plan_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_plan_runs (
    id character varying(80) NOT NULL,
    user_id character varying(255) NOT NULL,
    user_role character varying(20) NOT NULL,
    membership_tier character varying(20) DEFAULT 'free'::character varying NOT NULL,
    session_id character varying(255) NOT NULL,
    agent_mode character varying(40) NOT NULL,
    instruction text NOT NULL,
    language character varying(8) DEFAULT 'zh'::character varying NOT NULL,
    summary character varying(800) NOT NULL,
    plan_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    request_idempotency_key character varying(128) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    total_steps integer NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    active_job_id bigint,
    error_code character varying(120),
    error_message character varying(500),
    cancel_reason character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    CONSTRAINT agent_plan_runs_language_check CHECK (((language)::text = ANY ((ARRAY['zh'::character varying, 'en'::character varying])::text[]))),
    CONSTRAINT agent_plan_runs_mode_check CHECK (((agent_mode)::text = ANY ((ARRAY['ask_for_approval'::character varying, 'approve_for_me'::character varying, 'full_access'::character varying])::text[]))),
    CONSTRAINT agent_plan_runs_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT agent_plan_runs_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_plan_runs_request_key_check CHECK (((request_idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text)),
    CONSTRAINT agent_plan_runs_role_check CHECK (((user_role)::text = ANY ((ARRAY['user'::character varying, 'admin'::character varying, 'root'::character varying])::text[]))),
    CONSTRAINT agent_plan_runs_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting_approval'::character varying, 'waiting_client'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT agent_plan_runs_steps_check CHECK ((((total_steps >= 1) AND (total_steps <= 12)) AND ((current_step >= 0) AND (current_step <= total_steps)))),
    CONSTRAINT agent_plan_runs_tier_check CHECK (((membership_tier)::text = ANY ((ARRAY['free'::character varying, 'basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[])))
);


--
-- Name: agent_plan_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_plan_steps (
    id bigint NOT NULL,
    run_id character varying(80) NOT NULL,
    "position" integer NOT NULL,
    call_id character varying(80) NOT NULL,
    call_name character varying(160) NOT NULL,
    tool_key character varying(128) NOT NULL,
    reason character varying(500) DEFAULT ''::character varying NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolved_parameters jsonb,
    result_snapshot jsonb,
    status character varying(32) DEFAULT 'ready'::character varying NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    approval_reason_code character varying(120),
    parameter_digest character(64),
    approved_by_user_id character varying(255),
    approved_at timestamp with time zone,
    approval_consumed_at timestamp with time zone,
    execution_idempotency_key character varying(128) NOT NULL,
    error_code character varying(120),
    error_message character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    CONSTRAINT agent_plan_steps_digest_check CHECK (((parameter_digest IS NULL) OR (parameter_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT agent_plan_steps_idempotency_check CHECK (((execution_idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text)),
    CONSTRAINT agent_plan_steps_position_check CHECK ((("position" >= 1) AND ("position" <= 12))),
    CONSTRAINT agent_plan_steps_status_check CHECK (((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying, 'waiting_approval'::character varying, 'waiting_client'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: agent_plan_steps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_plan_steps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_plan_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_plan_steps_id_seq OWNED BY public.agent_plan_steps.id;


--
-- Name: agent_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_skills (
    id bigint NOT NULL,
    name character varying(64) NOT NULL,
    title character varying(160) NOT NULL,
    description character varying(500) DEFAULT ''::character varying NOT NULL,
    content text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    content_sha256 character(64) NOT NULL,
    source_key character varying(120),
    created_by_user_id character varying(255) NOT NULL,
    updated_by_user_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_skills_content_size_check CHECK ((octet_length(content) <= 65536)),
    CONSTRAINT agent_skills_name_check CHECK (((name)::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'::text)),
    CONSTRAINT agent_skills_sha256_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_skills_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying])::text[])))
);


--
-- Name: agent_skills_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_skills_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_skills_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_skills_id_seq OWNED BY public.agent_skills.id;


--
-- Name: agent_tool_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tool_audit_events (
    id bigint NOT NULL,
    event_type character varying(80) NOT NULL,
    outcome character varying(24) NOT NULL,
    actor_type character varying(24) DEFAULT 'agent'::character varying NOT NULL,
    user_id character varying(255) NOT NULL,
    session_id character varying(255) NOT NULL,
    tool_key character varying(128) NOT NULL,
    approval_id bigint,
    parameter_digest character(64),
    reason_code character varying(80),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_tool_audit_actor_check CHECK (((actor_type)::text = 'agent'::text)),
    CONSTRAINT agent_tool_audit_digest_check CHECK (((parameter_digest IS NULL) OR (parameter_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT agent_tool_audit_outcome_check CHECK (((outcome)::text = ANY ((ARRAY['issued'::character varying, 'approved'::character varying, 'denied'::character varying, 'executed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: agent_tool_audit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_tool_audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_tool_audit_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_tool_audit_events_id_seq OWNED BY public.agent_tool_audit_events.id;


--
-- Name: agent_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tools (
    id bigint NOT NULL,
    tool_key character varying(128) NOT NULL,
    display_name character varying(160) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    operation_class character varying(32) NOT NULL,
    required_roles text[] DEFAULT ARRAY['user'::text] NOT NULL,
    allowed_modes text[] DEFAULT ARRAY['ask_for_approval'::text, 'approve_for_me'::text, 'full_access'::text] NOT NULL,
    resource_scope character varying(24) DEFAULT 'user_owned'::character varying NOT NULL,
    requires_ownership boolean DEFAULT false NOT NULL,
    approval_policy character varying(16) DEFAULT 'policy'::character varying NOT NULL,
    input_schema jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_tools_approval_policy_check CHECK (((approval_policy)::text = ANY ((ARRAY['policy'::character varying, 'always'::character varying])::text[]))),
    CONSTRAINT agent_tools_key_check CHECK (((tool_key)::text ~ '^[a-z0-9][a-z0-9._:-]{1,127}$'::text)),
    CONSTRAINT agent_tools_modes_check CHECK (((cardinality(allowed_modes) > 0) AND (allowed_modes <@ ARRAY['ask_for_approval'::text, 'approve_for_me'::text, 'full_access'::text]))),
    CONSTRAINT agent_tools_operation_class_check CHECK (((operation_class)::text = ANY ((ARRAY['read'::character varying, 'creative'::character varying, 'reversible'::character varying, 'destructive'::character varying, 'publish'::character varying, 'external_mcp'::character varying, 'payment'::character varying, 'recharge'::character varying, 'refund'::character varying])::text[]))),
    CONSTRAINT agent_tools_roles_check CHECK (((cardinality(required_roles) > 0) AND (required_roles <@ ARRAY['root'::text, 'admin'::text, 'user'::text]))),
    CONSTRAINT agent_tools_scope_check CHECK (((resource_scope)::text = ANY ((ARRAY['user_owned'::character varying, 'platform'::character varying])::text[]))),
    CONSTRAINT agent_tools_version_check CHECK ((version > 0))
);


--
-- Name: agent_tools_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_tools_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_tools_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_tools_id_seq OWNED BY public.agent_tools.id;


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id bigint NOT NULL,
    title character varying(200) NOT NULL,
    content text NOT NULL,
    status character varying(16) DEFAULT 'draft'::character varying NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone,
    created_by character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by character varying(255),
    CONSTRAINT announcements_content_check CHECK (((char_length(btrim(content)) >= 1) AND (char_length(btrim(content)) <= 100000))),
    CONSTRAINT announcements_priority_check CHECK (((priority >= '-1000000'::integer) AND (priority <= 1000000))),
    CONSTRAINT announcements_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying])::text[]))),
    CONSTRAINT announcements_title_check CHECK (((char_length(btrim((title)::text)) >= 1) AND (char_length(btrim((title)::text)) <= 200)))
);


--
-- Name: TABLE announcements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.announcements IS 'Administrator-managed announcements with soft deletion.';


--
-- Name: announcements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.announcements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: announcements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.announcements_id_seq OWNED BY public.announcements.id;


--
-- Name: canvas_agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_agent_conversations (
    id character varying(80) NOT NULL,
    user_id character varying(255) NOT NULL,
    canvas_id character varying(64) NOT NULL,
    title character varying(160) DEFAULT ''::character varying NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    model_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    runtime_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_message_at timestamp with time zone,
    archived_at timestamp with time zone,
    CONSTRAINT canvas_agent_conversations_id_check CHECK (((id)::text ~ '^caconv_[0-9a-f]{32}$'::text)),
    CONSTRAINT canvas_agent_conversations_messages_check CHECK ((jsonb_typeof(messages) = 'array'::text)),
    CONSTRAINT canvas_agent_conversations_models_check CHECK ((jsonb_typeof(model_preferences) = 'object'::text)),
    CONSTRAINT canvas_agent_conversations_runtime_check CHECK ((jsonb_typeof(runtime_state) = 'object'::text))
);


--
-- Name: canvas_agent_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_agent_events (
    id bigint NOT NULL,
    run_id character varying(80) NOT NULL,
    user_id character varying(255) NOT NULL,
    event_type character varying(80) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canvas_agent_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);


--
-- Name: canvas_agent_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canvas_agent_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: canvas_agent_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.canvas_agent_events_id_seq OWNED BY public.canvas_agent_events.id;


--
-- Name: canvas_agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_agent_runs (
    id character varying(80) NOT NULL,
    conversation_id character varying(80) NOT NULL,
    user_id character varying(255) NOT NULL,
    canvas_id character varying(64) NOT NULL,
    user_role character varying(20) DEFAULT 'user'::character varying NOT NULL,
    membership_tier character varying(20) DEFAULT 'free'::character varying NOT NULL,
    agent_mode character varying(40) NOT NULL,
    text_model_key character varying(100) NOT NULL,
    image_model_key character varying(100),
    video_model_key character varying(100),
    instruction text NOT NULL,
    language character varying(8) DEFAULT 'zh'::character varying NOT NULL,
    context_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    final_summary text,
    request_idempotency_key character varying(128) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    active_job_id bigint,
    error_code character varying(120),
    error_message character varying(500),
    cancel_reason character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    CONSTRAINT canvas_agent_runs_context_check CHECK ((jsonb_typeof(context_snapshot) = 'object'::text)),
    CONSTRAINT canvas_agent_runs_id_check CHECK (((id)::text ~ '^carun_[0-9a-f]{32}$'::text)),
    CONSTRAINT canvas_agent_runs_language_check CHECK (((language)::text = ANY ((ARRAY['zh'::character varying, 'en'::character varying])::text[]))),
    CONSTRAINT canvas_agent_runs_mode_check CHECK (((agent_mode)::text = ANY ((ARRAY['ask_for_approval'::character varying, 'approve_for_me'::character varying, 'full_access'::character varying])::text[]))),
    CONSTRAINT canvas_agent_runs_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT canvas_agent_runs_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT canvas_agent_runs_request_key_check CHECK (((request_idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text)),
    CONSTRAINT canvas_agent_runs_role_check CHECK (((user_role)::text = ANY ((ARRAY['user'::character varying, 'admin'::character varying, 'root'::character varying])::text[]))),
    CONSTRAINT canvas_agent_runs_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting_approval'::character varying, 'waiting_external'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT canvas_agent_runs_step_check CHECK (((current_step >= 0) AND (current_step <= 240))),
    CONSTRAINT canvas_agent_runs_tier_check CHECK (((membership_tier)::text = ANY ((ARRAY['free'::character varying, 'basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[])))
);


--
-- Name: canvas_agent_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_agent_steps (
    id bigint NOT NULL,
    run_id character varying(80) NOT NULL,
    "position" integer NOT NULL,
    thought character varying(1200) DEFAULT ''::character varying NOT NULL,
    tool_key character varying(128),
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    result_snapshot jsonb,
    status character varying(32) DEFAULT 'ready'::character varying NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    approval_reason_code character varying(120),
    parameter_digest character(64),
    approved_by_user_id character varying(255),
    approved_at timestamp with time zone,
    approval_consumed_at timestamp with time zone,
    execution_idempotency_key character varying(128) NOT NULL,
    error_code character varying(120),
    error_message character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    CONSTRAINT canvas_agent_steps_digest_check CHECK (((parameter_digest IS NULL) OR (parameter_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT canvas_agent_steps_idempotency_check CHECK (((execution_idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text)),
    CONSTRAINT canvas_agent_steps_parameters_check CHECK ((jsonb_typeof(parameters) = 'object'::text)),
    CONSTRAINT canvas_agent_steps_position_check CHECK ((("position" >= 1) AND ("position" <= 240))),
    CONSTRAINT canvas_agent_steps_status_check CHECK (((status)::text = ANY ((ARRAY['ready'::character varying, 'running'::character varying, 'waiting_approval'::character varying, 'waiting_external'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: canvas_agent_steps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canvas_agent_steps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: canvas_agent_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.canvas_agent_steps_id_seq OWNED BY public.canvas_agent_steps.id;


--
-- Name: canvas_model_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_model_preferences (
    user_id character varying(255) NOT NULL,
    text_model_key character varying(100),
    image_model_key character varying(100),
    video_model_key character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: canvas_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_revisions (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    canvas_id character varying(64) NOT NULL,
    version integer NOT NULL,
    title character varying(120) NOT NULL,
    canvas_state jsonb NOT NULL,
    workflows_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    reason character varying(120) DEFAULT 'canvas.updated'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canvas_revisions_state_check CHECK ((jsonb_typeof(canvas_state) = 'object'::text)),
    CONSTRAINT canvas_revisions_workflows_check CHECK ((jsonb_typeof(workflows_snapshot) = 'array'::text))
);


--
-- Name: canvas_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canvas_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: canvas_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.canvas_revisions_id_seq OWNED BY public.canvas_revisions.id;


--
-- Name: canvas_workflow_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_workflow_versions (
    workflow_id character varying(80) NOT NULL,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    created_by_user_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canvas_workflow_versions_definition_check CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT canvas_workflow_versions_version_check CHECK ((version >= 1))
);


--
-- Name: canvas_workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_workflows (
    id character varying(80) NOT NULL,
    user_id character varying(255) NOT NULL,
    canvas_id character varying(64) NOT NULL,
    name character varying(160) NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT canvas_workflows_id_check CHECK (((id)::text ~ '^cwf_[0-9a-f]{32}$'::text)),
    CONSTRAINT canvas_workflows_version_check CHECK ((current_version >= 1))
);


--
-- Name: canvases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvases (
    id character varying(64) NOT NULL,
    user_id character varying(255) NOT NULL,
    title character varying(120) NOT NULL,
    canvas_state jsonb DEFAULT '{"elements": [], "viewport": {"x": 0, "y": 0, "scale": 1}, "background": {"mode": "grid"}}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: community_creation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_creation_events (
    id bigint NOT NULL,
    creation_id bigint NOT NULL,
    actor_user_id character varying(255),
    actor_role character varying(16) DEFAULT 'user'::character varying NOT NULL,
    event_type character varying(80) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT community_creation_events_role_check CHECK (((actor_role)::text = ANY ((ARRAY['system'::character varying, 'user'::character varying, 'admin'::character varying, 'root'::character varying])::text[])))
);


--
-- Name: community_creation_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.community_creation_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: community_creation_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.community_creation_events_id_seq OWNED BY public.community_creation_events.id;


--
-- Name: community_creation_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_creation_favorites (
    creation_id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: community_creation_likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_creation_likes (
    creation_id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: community_creation_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_creation_reports (
    id bigint NOT NULL,
    creation_id bigint NOT NULL,
    reporter_user_id character varying(255) NOT NULL,
    reason character varying(80) NOT NULL,
    details text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reviewed_by character varying(255),
    reviewed_at timestamp with time zone,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT community_creation_reports_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'reviewed'::character varying, 'dismissed'::character varying])::text[])))
);


--
-- Name: community_creation_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.community_creation_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: community_creation_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.community_creation_reports_id_seq OWNED BY public.community_creation_reports.id;


--
-- Name: content_object_cleanup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_object_cleanup_jobs (
    id bigint NOT NULL,
    owner_user_id character varying(255) NOT NULL,
    source_type character varying(32) NOT NULL,
    source_id character varying(255) NOT NULL,
    object_keys jsonb NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processing_started_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT content_object_cleanup_jobs_keys_array_check CHECK ((jsonb_typeof(object_keys) = 'array'::text)),
    CONSTRAINT content_object_cleanup_jobs_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'failed'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: content_object_cleanup_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_object_cleanup_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_object_cleanup_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_object_cleanup_jobs_id_seq OWNED BY public.content_object_cleanup_jobs.id;


--
-- Name: content_recycle_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_recycle_entries (
    id bigint NOT NULL,
    owner_user_id character varying(255) NOT NULL,
    resource_type character varying(32) NOT NULL,
    resource_id character varying(255) NOT NULL,
    resource_label character varying(255),
    deletion_origin character varying(16) NOT NULL,
    visibility character varying(16) NOT NULL,
    deleted_by_user_id character varying(255) NOT NULL,
    deleted_by_role character varying(16) NOT NULL,
    deletion_reason text,
    membership_tier_at_deletion character varying(20) DEFAULT 'free'::character varying NOT NULL,
    resource_snapshot jsonb NOT NULL,
    reference_snapshot jsonb DEFAULT '{"canvases": [], "retained_creations": []}'::jsonb NOT NULL,
    object_keys jsonb DEFAULT '[]'::jsonb NOT NULL,
    status character varying(24) DEFAULT 'active'::character varying NOT NULL,
    deleted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    purge_after timestamp with time zone NOT NULL,
    restored_at timestamp with time zone,
    restored_by_user_id character varying(255),
    purged_at timestamp with time zone,
    purged_by_user_id character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT content_recycle_entries_deleted_by_role_check CHECK (((deleted_by_role)::text = ANY ((ARRAY['user'::character varying, 'admin'::character varying, 'root'::character varying, 'system'::character varying])::text[]))),
    CONSTRAINT content_recycle_entries_object_keys_array_check CHECK ((jsonb_typeof(object_keys) = 'array'::text)),
    CONSTRAINT content_recycle_entries_origin_check CHECK (((deletion_origin)::text = ANY ((ARRAY['user'::character varying, 'admin'::character varying])::text[]))),
    CONSTRAINT content_recycle_entries_origin_visibility_check CHECK (((((deletion_origin)::text = 'user'::text) AND ((visibility)::text = 'user'::text)) OR (((deletion_origin)::text = 'admin'::text) AND ((visibility)::text = 'admin_only'::text)))),
    CONSTRAINT content_recycle_entries_resource_type_check CHECK (((resource_type)::text = ANY ((ARRAY['creation'::character varying, 'canvas'::character varying, 'private_template'::character varying, 'digital_human'::character varying, 'upload'::character varying])::text[]))),
    CONSTRAINT content_recycle_entries_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'restored'::character varying, 'purged'::character varying])::text[]))),
    CONSTRAINT content_recycle_entries_visibility_check CHECK (((visibility)::text = ANY ((ARRAY['user'::character varying, 'admin_only'::character varying])::text[])))
);


--
-- Name: content_recycle_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_recycle_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_recycle_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_recycle_entries_id_seq OWNED BY public.content_recycle_entries.id;


--
-- Name: content_recycle_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_recycle_notifications (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    notification_type character varying(32) NOT NULL,
    title character varying(160) NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT content_recycle_notifications_type_check CHECK (((notification_type)::text = ANY ((ARRAY['content_removed'::character varying, 'content_restored'::character varying])::text[])))
);


--
-- Name: content_recycle_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_recycle_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_recycle_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_recycle_notifications_id_seq OWNED BY public.content_recycle_notifications.id;


--
-- Name: content_restore_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_restore_requests (
    id bigint NOT NULL,
    recycle_entry_id bigint NOT NULL,
    requested_by_user_id character varying(255) NOT NULL,
    request_reason text NOT NULL,
    idempotency_key character varying(128),
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    reviewed_by_user_id character varying(255),
    review_note text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reviewed_at timestamp with time zone,
    CONSTRAINT content_restore_requests_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: content_restore_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_restore_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_restore_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_restore_requests_id_seq OWNED BY public.content_restore_requests.id;


--
-- Name: creations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creations (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    provider character varying(50),
    model character varying(100),
    scene_key character varying(50),
    scene_name character varying(100),
    type character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    provider_status character varying(50),
    task_id character varying(255),
    prompt text,
    content text,
    thumbnail_url text,
    content_object_key character varying(255),
    thumbnail_object_key character varying(255),
    request_idempotency_key character varying(128),
    charge_status character varying(20) DEFAULT 'none'::character varying NOT NULL,
    points_reserved integer DEFAULT 0 NOT NULL,
    points_cost integer DEFAULT 0 NOT NULL,
    generation_time_ms integer,
    error_message text,
    meta_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completion_notification_sent_at timestamp with time zone,
    completion_notification_skipped_at timestamp with time zone,
    completion_notification_claimed_at timestamp with time zone,
    completion_notification_last_error character varying(500),
    community_status character varying(16) DEFAULT 'private'::character varying NOT NULL,
    community_title character varying(160),
    community_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    community_prompt_public boolean DEFAULT false NOT NULL,
    community_visual_parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    community_published_at timestamp with time zone,
    community_featured boolean DEFAULT false NOT NULL,
    community_hidden boolean DEFAULT false NOT NULL,
    community_hidden_reason text,
    community_hidden_at timestamp with time zone,
    community_hidden_by character varying(255),
    CONSTRAINT creations_community_status_check CHECK (((community_status)::text = ANY ((ARRAY['private'::character varying, 'public'::character varying])::text[])))
);


--
-- Name: creations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.creations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: creations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.creations_id_seq OWNED BY public.creations.id;


--
-- Name: digital_human_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.digital_human_roles (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    role_name character varying(120) NOT NULL,
    role_description text,
    prompt_text text,
    status character varying(20) DEFAULT 'collecting'::character varying NOT NULL,
    qr_token character varying(80) NOT NULL,
    avatar_url text,
    avatar_object_key character varying(255),
    demo_video_url text,
    demo_video_object_key character varying(255),
    ready_at timestamp with time zone,
    meta_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    qr_token_issued_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    qr_token_expires_at timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '24:00:00'::interval) NOT NULL,
    qr_token_claimed_at timestamp with time zone,
    qr_token_consumed_at timestamp with time zone,
    qr_token_revoked_at timestamp with time zone,
    CONSTRAINT digital_human_roles_capture_token_ttl_check CHECK (((qr_token_expires_at >= qr_token_issued_at) AND (qr_token_expires_at <= (qr_token_issued_at + '24:00:00'::interval))))
);


--
-- Name: COLUMN digital_human_roles.qr_token_issued_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.digital_human_roles.qr_token_issued_at IS 'Server-recorded issuance time used to enforce the 24-hour maximum lifetime.';


--
-- Name: COLUMN digital_human_roles.qr_token_expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.digital_human_roles.qr_token_expires_at IS 'Capture token expires no later than 24 hours after issuance.';


--
-- Name: COLUMN digital_human_roles.qr_token_claimed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.digital_human_roles.qr_token_claimed_at IS 'Set atomically before public upload to prevent concurrent token reuse.';


--
-- Name: COLUMN digital_human_roles.qr_token_consumed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.digital_human_roles.qr_token_consumed_at IS 'Set after a successful public capture upload; consumed tokens cannot be reused.';


--
-- Name: COLUMN digital_human_roles.qr_token_revoked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.digital_human_roles.qr_token_revoked_at IS 'Set when the owner revokes or rotates the capture token.';


--
-- Name: digital_human_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.digital_human_roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: digital_human_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.digital_human_roles_id_seq OWNED BY public.digital_human_roles.id;


--
-- Name: execution_governor_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_governor_leases (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    membership_tier character varying(20) NOT NULL,
    operation_key character varying(128) NOT NULL,
    queue_name character varying(80) DEFAULT 'default'::character varying NOT NULL,
    idempotency_key character varying(128),
    state character varying(20) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message character varying(2000),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    expires_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT execution_governor_lease_idempotency_check CHECK (((idempotency_key IS NULL) OR ((idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text))),
    CONSTRAINT execution_governor_lease_operation_check CHECK (((operation_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT execution_governor_lease_queue_check CHECK (((queue_name)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'::text)),
    CONSTRAINT execution_governor_lease_running_check CHECK ((((state)::text <> ALL ((ARRAY['queued'::character varying, 'running'::character varying])::text[])) OR (expires_at IS NOT NULL))),
    CONSTRAINT execution_governor_lease_state_check CHECK (((state)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT execution_governor_lease_terminal_check CHECK ((((state)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[])) OR (completed_at IS NOT NULL))),
    CONSTRAINT execution_governor_lease_tier_check CHECK (((membership_tier)::text = ANY ((ARRAY['free'::character varying, 'basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[])))
);


--
-- Name: execution_governor_leases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.execution_governor_leases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: execution_governor_leases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.execution_governor_leases_id_seq OWNED BY public.execution_governor_leases.id;


--
-- Name: execution_governor_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_governor_policies (
    id bigint NOT NULL,
    membership_tier character varying(20) NOT NULL,
    operation_key character varying(128) NOT NULL,
    max_per_minute integer NOT NULL,
    max_concurrent integer NOT NULL,
    max_queue_depth integer NOT NULL,
    daily_quota integer NOT NULL,
    lease_duration_ms integer DEFAULT 1800000 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_governor_operation_check CHECK ((((operation_key)::text = '*'::text) OR ((operation_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT execution_governor_policies_daily_quota_check CHECK ((daily_quota > 0)),
    CONSTRAINT execution_governor_policies_lease_duration_ms_check CHECK (((lease_duration_ms >= 10000) AND (lease_duration_ms <= 86400000))),
    CONSTRAINT execution_governor_policies_max_concurrent_check CHECK ((max_concurrent > 0)),
    CONSTRAINT execution_governor_policies_max_per_minute_check CHECK ((max_per_minute > 0)),
    CONSTRAINT execution_governor_policies_max_queue_depth_check CHECK ((max_queue_depth > 0)),
    CONSTRAINT execution_governor_tier_check CHECK (((membership_tier)::text = ANY ((ARRAY['free'::character varying, 'basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[])))
);


--
-- Name: execution_governor_policies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.execution_governor_policies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: execution_governor_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.execution_governor_policies_id_seq OWNED BY public.execution_governor_policies.id;


--
-- Name: generation_charge_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generation_charge_rules (
    id bigint NOT NULL,
    output_type character varying(20) NOT NULL,
    provider character varying(50) NOT NULL,
    scene_key character varying(50),
    model character varying(100),
    seconds integer,
    size character varying(20),
    points_cost integer NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    meta_rule jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    generation_mode character varying(16) DEFAULT 'all'::character varying NOT NULL,
    CONSTRAINT generation_charge_rules_mode_check CHECK (((generation_mode)::text = ANY ((ARRAY['all'::character varying, 'freeform'::character varying, 'template'::character varying])::text[])))
);


--
-- Name: generation_charge_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generation_charge_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generation_charge_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generation_charge_rules_id_seq OWNED BY public.generation_charge_rules.id;


--
-- Name: global_agent_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.global_agent_preferences (
    user_id character varying(255) NOT NULL,
    access_mode character varying(40) DEFAULT 'approve_for_me'::character varying NOT NULL,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT global_agent_preferences_mode_check CHECK (((access_mode)::text = ANY ((ARRAY['ask_for_approval'::character varying, 'approve_for_me'::character varying, 'full_access'::character varying])::text[]))),
    CONSTRAINT global_agent_preferences_preferences_check CHECK ((jsonb_typeof(preferences) = 'object'::text))
);


--
-- Name: identity_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_links (
    id bigint NOT NULL,
    provider character varying(64) NOT NULL,
    issuer character varying(512) NOT NULL,
    subject character varying(255) NOT NULL,
    stardraw_user_id character varying(255) NOT NULL,
    email character varying(320),
    email_verified_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    username character varying(128),
    phone_number character varying(64),
    CONSTRAINT identity_links_issuer_check CHECK ((length(btrim((issuer)::text)) > 0)),
    CONSTRAINT identity_links_provider_check CHECK ((length(btrim((provider)::text)) > 0)),
    CONSTRAINT identity_links_subject_check CHECK ((length(btrim((subject)::text)) > 0)),
    CONSTRAINT identity_links_user_check CHECK ((length(btrim((stardraw_user_id)::text)) > 0))
);


--
-- Name: identity_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.identity_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: identity_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.identity_links_id_seq OWNED BY public.identity_links.id;


--
-- Name: invitation_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation_codes (
    id bigint NOT NULL,
    code character varying(32) NOT NULL,
    code_type character varying(16) NOT NULL,
    owner_user_id character varying(255),
    created_by character varying(255),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT invitation_codes_owner_check CHECK (((((code_type)::text = 'personal'::text) AND (owner_user_id IS NOT NULL)) OR ((code_type)::text = 'common'::text))),
    CONSTRAINT invitation_codes_state_check CHECK ((((is_active = true) AND (revoked_at IS NULL)) OR ((is_active = false) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT invitation_codes_type_check CHECK (((code_type)::text = ANY ((ARRAY['personal'::character varying, 'common'::character varying])::text[])))
);


--
-- Name: invitation_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invitation_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invitation_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invitation_codes_id_seq OWNED BY public.invitation_codes.id;


--
-- Name: invitation_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation_redemptions (
    id bigint NOT NULL,
    code_id bigint NOT NULL,
    inviter_user_id character varying(255),
    invitee_user_id character varying(255) NOT NULL,
    inviter_reward_points integer DEFAULT 0 NOT NULL,
    invitee_reward_points integer DEFAULT 0 NOT NULL,
    reward_expires_at timestamp with time zone,
    inviter_point_ledger_id bigint,
    invitee_point_ledger_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invitation_redemptions_invitee_reward_check CHECK ((invitee_reward_points >= 0)),
    CONSTRAINT invitation_redemptions_inviter_reward_check CHECK ((inviter_reward_points >= 0)),
    CONSTRAINT invitation_redemptions_not_self_check CHECK (((inviter_user_id IS NULL) OR ((inviter_user_id)::text <> (invitee_user_id)::text))),
    CONSTRAINT invitation_redemptions_reward_check CHECK (((inviter_reward_points > 0) OR (invitee_reward_points > 0)))
);


--
-- Name: invitation_redemptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invitation_redemptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invitation_redemptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invitation_redemptions_id_seq OWNED BY public.invitation_redemptions.id;


--
-- Name: invitation_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation_settings (
    id smallint DEFAULT 1 NOT NULL,
    inviter_reward_points integer DEFAULT 0 NOT NULL,
    invitee_reward_points integer DEFAULT 0 NOT NULL,
    reward_validity_days integer DEFAULT 30 NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invitation_settings_invitee_reward_check CHECK ((invitee_reward_points >= 0)),
    CONSTRAINT invitation_settings_inviter_reward_check CHECK ((inviter_reward_points >= 0)),
    CONSTRAINT invitation_settings_singleton_check CHECK ((id = 1)),
    CONSTRAINT invitation_settings_validity_check CHECK ((reward_validity_days >= 0))
);


--
-- Name: mcp_call_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_call_audit (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    mcp_server_id bigint NOT NULL,
    connection_id bigint,
    tool_name character varying(160) NOT NULL,
    parameter_digest character(64),
    approval_id bigint,
    outcome character varying(24) NOT NULL,
    status_code integer,
    latency_ms integer,
    error_code character varying(120),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_call_audit_outcome_check CHECK (((outcome)::text = ANY ((ARRAY['started'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'denied'::character varying])::text[])))
);


--
-- Name: mcp_call_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mcp_call_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mcp_call_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mcp_call_audit_id_seq OWNED BY public.mcp_call_audit.id;


--
-- Name: mcp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_connections (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    mcp_server_id bigint NOT NULL,
    provider_account_id character varying(255) NOT NULL,
    issuer text NOT NULL,
    resource_uri text NOT NULL,
    token_endpoint text,
    revoke_endpoint text,
    encrypted_access_token text NOT NULL,
    encrypted_refresh_token text,
    token_type character varying(40) DEFAULT 'Bearer'::character varying NOT NULL,
    token_expires_at timestamp with time zone,
    scopes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    last_refresh_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_error_code character varying(100),
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_connections_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying, 'error'::character varying])::text[])))
);


--
-- Name: mcp_connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mcp_connections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mcp_connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mcp_connections_id_seq OWNED BY public.mcp_connections.id;


--
-- Name: mcp_oauth_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_transactions (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    mcp_server_id bigint NOT NULL,
    issuer text NOT NULL,
    resource_uri text NOT NULL,
    authorization_endpoint text NOT NULL,
    token_endpoint text NOT NULL,
    revoke_endpoint text,
    redirect_uri text NOT NULL,
    state_hash character(64) NOT NULL,
    encrypted_pkce_verifier text NOT NULL,
    client_id text NOT NULL,
    scopes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    failure_reason text,
    CONSTRAINT mcp_oauth_transaction_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'used'::character varying, 'failed'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: mcp_oauth_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mcp_oauth_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mcp_oauth_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mcp_oauth_transactions_id_seq OWNED BY public.mcp_oauth_transactions.id;


--
-- Name: mcp_server_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_server_tools (
    id bigint NOT NULL,
    server_id bigint NOT NULL,
    tool_name character varying(160) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    operation_class character varying(32) DEFAULT 'external_mcp'::character varying NOT NULL,
    required_roles text[] DEFAULT ARRAY['user'::text, 'admin'::text, 'root'::text] NOT NULL,
    approval_policy character varying(16) DEFAULT 'policy'::character varying NOT NULL,
    input_schema jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_server_tools_approval_check CHECK (((approval_policy)::text = ANY ((ARRAY['policy'::character varying, 'always'::character varying])::text[]))),
    CONSTRAINT mcp_server_tools_operation_check CHECK (((operation_class)::text = ANY ((ARRAY['read'::character varying, 'creative'::character varying, 'reversible'::character varying, 'destructive'::character varying, 'publish'::character varying, 'external_mcp'::character varying])::text[])))
);


--
-- Name: mcp_server_tools_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mcp_server_tools_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mcp_server_tools_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mcp_server_tools_id_seq OWNED BY public.mcp_server_tools.id;


--
-- Name: mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_servers (
    id bigint NOT NULL,
    server_key character varying(80) NOT NULL,
    display_name character varying(160) NOT NULL,
    canonical_url text NOT NULL,
    provider_adapter character varying(80) NOT NULL,
    status character varying(24) DEFAULT 'draft'::character varying NOT NULL,
    transport character varying(32) DEFAULT 'streamable_http'::character varying NOT NULL,
    allowed_domains text[] DEFAULT ARRAY[]::text[] NOT NULL,
    oauth_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    discovery_cache jsonb DEFAULT '{}'::jsonb NOT NULL,
    admin_notes text,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_servers_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'enabled'::character varying, 'disabled'::character varying, 'catalog_pending'::character varying])::text[]))),
    CONSTRAINT mcp_servers_transport_check CHECK (((transport)::text = ANY ((ARRAY['streamable_http'::character varying, 'sse'::character varying])::text[])))
);


--
-- Name: mcp_servers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mcp_servers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mcp_servers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mcp_servers_id_seq OWNED BY public.mcp_servers.id;


--
-- Name: membership_bonus_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership_bonus_grants (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    membership_tier character varying(20) NOT NULL,
    cycle_start_at timestamp with time zone NOT NULL,
    cycle_end_at timestamp with time zone NOT NULL,
    points_granted integer NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    point_ledger_id bigint,
    triggered_by character varying(20) DEFAULT 'system'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp with time zone,
    lot_id bigint
);


--
-- Name: membership_bonus_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.membership_bonus_grants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: membership_bonus_grants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.membership_bonus_grants_id_seq OWNED BY public.membership_bonus_grants.id;


--
-- Name: metered_agent_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metered_agent_operations (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    operation_type character varying(60) NOT NULL,
    request_idempotency_key character varying(128) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(30) DEFAULT 'initializing'::character varying NOT NULL,
    points_cost integer NOT NULL,
    model_key character varying(100) NOT NULL,
    model_route_id bigint,
    response_snapshot jsonb,
    error_code character varying(100),
    error_message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp with time zone,
    provider_completed_at timestamp with time zone,
    reconciliation_attempts integer DEFAULT 0 NOT NULL,
    last_reconciliation_at timestamp with time zone,
    last_reconciliation_error text,
    reconciliation_alerted_at timestamp with time zone,
    reserved_points integer NOT NULL,
    charged_points integer,
    usage_snapshot jsonb,
    pricing_snapshot jsonb,
    CONSTRAINT metered_agent_operations_charged_points_check CHECK (((charged_points IS NULL) OR (charged_points >= 0))),
    CONSTRAINT metered_agent_operations_points_cost_check CHECK ((points_cost > 0)),
    CONSTRAINT metered_agent_operations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT metered_agent_operations_reserved_points_check CHECK ((reserved_points > 0)),
    CONSTRAINT metered_agent_operations_status_check CHECK (((status)::text = ANY ((ARRAY['initializing'::character varying, 'reserved'::character varying, 'settlement_pending'::character varying, 'completed'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT metered_agent_operations_type_check CHECK (((operation_type)::text = ANY ((ARRAY['canvas_agent_plan'::character varying, 'digital_human_script_optimizer'::character varying, 'generation_prompt_optimizer'::character varying, 'global_agent_plan'::character varying])::text[])))
);


--
-- Name: metered_agent_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metered_agent_operations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metered_agent_operations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metered_agent_operations_id_seq OWNED BY public.metered_agent_operations.id;


--
-- Name: model_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_catalog (
    model_key character varying(100) NOT NULL,
    display_name character varying(160) NOT NULL,
    output_type character varying(20) NOT NULL,
    description text,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolutions jsonb DEFAULT '[]'::jsonb NOT NULL,
    aspect_ratios jsonb DEFAULT '[]'::jsonb NOT NULL,
    minimum_membership_tier character varying(20) DEFAULT 'free'::character varying NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_user_id character varying(255),
    updated_by_user_id character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT model_catalog_aspect_ratios_array_check CHECK ((jsonb_typeof(aspect_ratios) = 'array'::text)),
    CONSTRAINT model_catalog_capabilities_object_check CHECK ((jsonb_typeof(capabilities) = 'object'::text)),
    CONSTRAINT model_catalog_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT model_catalog_output_type_check CHECK (((output_type)::text = ANY ((ARRAY['image'::character varying, 'video'::character varying, 'agent'::character varying])::text[]))),
    CONSTRAINT model_catalog_resolutions_array_check CHECK ((jsonb_typeof(resolutions) = 'array'::text)),
    CONSTRAINT model_catalog_tier_check CHECK (((minimum_membership_tier)::text = ANY ((ARRAY['free'::character varying, 'basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[])))
);


--
-- Name: model_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_routes (
    id bigint NOT NULL,
    model_key character varying(100) NOT NULL,
    provider_key character varying(50) NOT NULL,
    upstream_model_id character varying(160) NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    route_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_user_id character varying(255),
    updated_by_user_id character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT model_routes_config_object_check CHECK ((jsonb_typeof(route_config) = 'object'::text))
);


--
-- Name: model_routes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.model_routes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: model_routes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.model_routes_id_seq OWNED BY public.model_routes.id;


--
-- Name: oauth_client_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_client_registrations (
    id bigint NOT NULL,
    mcp_server_id bigint NOT NULL,
    issuer text NOT NULL,
    registration_mode character varying(32) NOT NULL,
    client_id text NOT NULL,
    encrypted_client_secret text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(24) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_client_registration_mode_check CHECK (((registration_mode)::text = ANY ((ARRAY['pre_registered'::character varying, 'client_id_metadata'::character varying, 'dynamic_registration'::character varying, 'manual'::character varying])::text[])))
);


--
-- Name: oauth_client_registrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.oauth_client_registrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: oauth_client_registrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.oauth_client_registrations_id_seq OWNED BY public.oauth_client_registrations.id;


--
-- Name: persistent_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.persistent_jobs (
    id bigint NOT NULL,
    queue_name character varying(80) DEFAULT 'default'::character varying NOT NULL,
    job_type character varying(120) NOT NULL,
    user_id character varying(255),
    idempotency_key character varying(128),
    request_hash character(64) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    input_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(24) DEFAULT 'queued'::character varying NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(180),
    lease_expires_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    result_snapshot jsonb,
    error_code character varying(120),
    error_message text,
    cancel_reason character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    user_notification_claimed_at timestamp with time zone,
    user_notification_sent_at timestamp with time zone,
    user_notification_skipped_at timestamp with time zone,
    user_notification_last_error character varying(120),
    dead_letter_alert_claimed_at timestamp with time zone,
    dead_letter_alerted_at timestamp with time zone,
    dead_letter_alert_last_error character varying(120),
    CONSTRAINT persistent_jobs_attempts_check CHECK (((attempts >= 0) AND (attempts <= max_attempts))),
    CONSTRAINT persistent_jobs_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT persistent_jobs_idempotency_key_check CHECK (((idempotency_key IS NULL) OR ((idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text))),
    CONSTRAINT persistent_jobs_input_refs_array_check CHECK ((jsonb_typeof(input_refs) = 'array'::text)),
    CONSTRAINT persistent_jobs_lease_check CHECK (((((status)::text = 'running'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR (((status)::text <> 'running'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT persistent_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 1000))),
    CONSTRAINT persistent_jobs_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT persistent_jobs_payload_object_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT persistent_jobs_priority_check CHECK (((priority >= '-100000'::integer) AND (priority <= 100000))),
    CONSTRAINT persistent_jobs_queue_name_check CHECK (((queue_name)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'::text)),
    CONSTRAINT persistent_jobs_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT persistent_jobs_terminal_cancel_check CHECK ((((status)::text <> 'cancelled'::text) OR (cancelled_at IS NOT NULL))),
    CONSTRAINT persistent_jobs_terminal_failure_check CHECK ((((status)::text <> 'failed'::text) OR (failed_at IS NOT NULL))),
    CONSTRAINT persistent_jobs_terminal_result_check CHECK ((((status)::text <> 'completed'::text) OR ((result_snapshot IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT persistent_jobs_type_check CHECK (((job_type)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'::text)),
    CONSTRAINT persistent_jobs_user_notification_outcome_check CHECK (((user_notification_sent_at IS NULL) OR (user_notification_skipped_at IS NULL)))
);


--
-- Name: persistent_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.persistent_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: persistent_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.persistent_jobs_id_seq OWNED BY public.persistent_jobs.id;


--
-- Name: point_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_ledger (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    entry_type character varying(50) NOT NULL,
    source_type character varying(50) NOT NULL,
    source_id character varying(255) NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    change_points integer NOT NULL,
    held_points_change integer DEFAULT 0 NOT NULL,
    balance_after integer NOT NULL,
    held_after integer NOT NULL,
    note text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    lot_id bigint
);


--
-- Name: point_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.point_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: point_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.point_ledger_id_seq OWNED BY public.point_ledger.id;


--
-- Name: point_lot_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_lot_allocations (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    creation_id bigint,
    lot_id bigint NOT NULL,
    amount_points integer NOT NULL,
    status character varying(20) DEFAULT 'held'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    source_type character varying(50) NOT NULL,
    source_id character varying(255) NOT NULL,
    CONSTRAINT point_lot_allocations_amount_points_check CHECK ((amount_points > 0)),
    CONSTRAINT point_lot_allocations_status_check CHECK (((status)::text = ANY ((ARRAY['held'::character varying, 'charged'::character varying, 'released'::character varying, 'refunded'::character varying])::text[])))
);


--
-- Name: point_lot_allocations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.point_lot_allocations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: point_lot_allocations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.point_lot_allocations_id_seq OWNED BY public.point_lot_allocations.id;


--
-- Name: point_lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_lots (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    source_type character varying(50) NOT NULL,
    source_id character varying(255) NOT NULL,
    order_id bigint,
    category character varying(30) DEFAULT 'purchased'::character varying NOT NULL,
    total_points integer NOT NULL,
    available_points integer DEFAULT 0 NOT NULL,
    held_points integer DEFAULT 0 NOT NULL,
    consumed_points integer DEFAULT 0 NOT NULL,
    expired_points integer DEFAULT 0 NOT NULL,
    refunded_points integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    idempotency_key character varying(128) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    product_order_type character varying(24),
    product_order_id bigint,
    CONSTRAINT point_lots_available_points_check CHECK ((available_points >= 0)),
    CONSTRAINT point_lots_category_check CHECK (((category)::text = ANY ((ARRAY['purchased'::character varying, 'package_bonus'::character varying, 'membership_bonus'::character varying, 'legacy'::character varying, 'manual'::character varying])::text[]))),
    CONSTRAINT point_lots_check CHECK ((((((available_points + held_points) + consumed_points) + expired_points) + refunded_points) = total_points)),
    CONSTRAINT point_lots_consumed_points_check CHECK ((consumed_points >= 0)),
    CONSTRAINT point_lots_expired_points_check CHECK ((expired_points >= 0)),
    CONSTRAINT point_lots_held_points_check CHECK ((held_points >= 0)),
    CONSTRAINT point_lots_product_order_pair_check CHECK ((((product_order_type IS NULL) AND (product_order_id IS NULL)) OR (((product_order_type)::text = ANY ((ARRAY['subscription'::character varying, 'point_package'::character varying])::text[])) AND (product_order_id IS NOT NULL)))),
    CONSTRAINT point_lots_refunded_points_check CHECK ((refunded_points >= 0)),
    CONSTRAINT point_lots_total_points_check CHECK ((total_points > 0))
);


--
-- Name: point_lots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.point_lots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: point_lots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.point_lots_id_seq OWNED BY public.point_lots.id;


--
-- Name: point_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_orders (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    order_no character varying(64) NOT NULL,
    package_key character varying(50) NOT NULL,
    package_name character varying(100) NOT NULL,
    amount_cents integer NOT NULL,
    points integer NOT NULL,
    bonus_points integer DEFAULT 0 NOT NULL,
    total_points integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    payment_method character varying(50) DEFAULT 'mock'::character varying NOT NULL,
    client_request_id character varying(64),
    confirm_request_id character varying(64),
    payment_txn_id character varying(128),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    paid_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    provider_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    refunded_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    payment_reconciliation_state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    payment_reconciliation_attempts integer DEFAULT 0 NOT NULL,
    next_payment_reconciliation_at timestamp with time zone,
    last_payment_reconciliation_at timestamp with time zone,
    last_payment_reconciliation_error character varying(500),
    payment_reconciliation_claimed_at timestamp with time zone,
    payment_reconciliation_lease_id uuid,
    payment_closed_at timestamp with time zone,
    CONSTRAINT point_orders_reconciliation_attempts_check CHECK ((payment_reconciliation_attempts >= 0)),
    CONSTRAINT point_orders_reconciliation_state_check CHECK (((payment_reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying, 'succeeded'::character varying, 'closed'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT point_orders_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'partially_refunded'::character varying, 'refunded'::character varying])::text[])))
);


--
-- Name: point_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.point_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: point_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.point_orders_id_seq OWNED BY public.point_orders.id;


--
-- Name: point_package_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_package_refunds (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    refund_no character varying(80) NOT NULL,
    requested_points integer NOT NULL,
    refunded_points integer DEFAULT 0 NOT NULL,
    amount_cents integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reason text,
    provider_refund_id character varying(255),
    idempotency_key character varying(128) NOT NULL,
    reconciliation_state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    reconciliation_attempts integer DEFAULT 0 NOT NULL,
    next_reconciliation_at timestamp with time zone,
    last_reconciliation_at timestamp with time zone,
    last_reconciliation_error character varying(500),
    reconciliation_claimed_at timestamp with time zone,
    reconciliation_lease_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT point_package_refunds_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT point_package_refunds_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT point_package_refunds_reconciliation_attempts_check CHECK ((reconciliation_attempts >= 0)),
    CONSTRAINT point_package_refunds_reconciliation_state_check CHECK (((reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying, 'success'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT point_package_refunds_refunded_points_check CHECK ((refunded_points >= 0)),
    CONSTRAINT point_package_refunds_requested_points_check CHECK ((requested_points > 0)),
    CONSTRAINT point_package_refunds_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: point_package_refunds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.point_package_refunds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: point_package_refunds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.point_package_refunds_id_seq OWNED BY public.point_package_refunds.id;


--
-- Name: point_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_packages (
    id bigint NOT NULL,
    package_key character varying(50) NOT NULL,
    package_name character varying(100) NOT NULL,
    price_cents integer NOT NULL,
    points integer NOT NULL,
    bonus_points integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    description text,
    display_order integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT point_packages_bonus_nonnegative_check CHECK ((bonus_points >= 0)),
    CONSTRAINT point_packages_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT point_packages_points_positive_check CHECK ((points > 0)),
    CONSTRAINT point_packages_price_positive_check CHECK ((price_cents > 0)),
    CONSTRAINT point_packages_total_points_range_check CHECK ((((points)::bigint + (bonus_points)::bigint) <= 2147483647))
);


--
-- Name: point_packages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.point_packages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: point_packages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.point_packages_id_seq OWNED BY public.point_packages.id;


--
-- Name: prompt_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_templates (
    id bigint NOT NULL,
    scene_key character varying(50) NOT NULL,
    scene_name character varying(100) NOT NULL,
    output_type character varying(20) NOT NULL,
    target_provider character varying(50) NOT NULL,
    default_model character varying(100),
    default_seconds integer,
    default_size character varying(20),
    system_prompt text NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    featured_order integer DEFAULT 0 NOT NULL,
    preview_title character varying(120),
    preview_description text,
    preview_image_url text,
    preview_object_key character varying(255),
    starter_prompt text,
    placeholder_text text,
    requires_reference boolean DEFAULT false NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    preview_video_url text,
    preview_video_object_key character varying(255),
    owner_user_id character varying(255),
    visibility character varying(16) DEFAULT 'public'::character varying NOT NULL,
    approval_status character varying(16) DEFAULT 'approved'::character varying NOT NULL,
    required_membership_tier character varying(20) DEFAULT 'free'::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    publication_requested_at timestamp with time zone,
    publication_reviewed_at timestamp with time zone,
    publication_review_note text,
    source_key character varying(120),
    source_item_id character varying(120),
    source_url text,
    catalog_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT prompt_templates_approval_status_check CHECK (((approval_status)::text = ANY ((ARRAY['approved'::character varying, 'pending'::character varying, 'rejected'::character varying, 'private'::character varying])::text[]))),
    CONSTRAINT prompt_templates_catalog_metadata_object_check CHECK ((jsonb_typeof(catalog_metadata) = 'object'::text)),
    CONSTRAINT prompt_templates_required_tier_check CHECK (((required_membership_tier)::text = ANY ((ARRAY['free'::character varying, 'basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[]))),
    CONSTRAINT prompt_templates_visibility_check CHECK (((visibility)::text = ANY ((ARRAY['public'::character varying, 'private'::character varying])::text[])))
);


--
-- Name: prompt_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prompt_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prompt_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prompt_templates_id_seq OWNED BY public.prompt_templates.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version integer NOT NULL,
    filename character varying(255) NOT NULL,
    sha256 character(64) NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_by character varying(255) NOT NULL,
    release_version character varying(128) NOT NULL,
    execution_duration_ms bigint NOT NULL,
    CONSTRAINT schema_migrations_execution_duration_ms_check CHECK ((execution_duration_ms >= 0)),
    CONSTRAINT schema_migrations_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT schema_migrations_version_check CHECK ((version > 0))
);


--
-- Name: TABLE schema_migrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.schema_migrations IS 'Immutable checksums for controlled database migrations; historical rows require a separate audited backfill.';


--
-- Name: subscription_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_orders (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    subscription_id bigint,
    plan_id bigint,
    order_no character varying(80) NOT NULL,
    order_type character varying(20) DEFAULT 'initial'::character varying NOT NULL,
    plan_key character varying(80) NOT NULL,
    plan_name character varying(120) NOT NULL,
    membership_tier character varying(20) NOT NULL,
    billing_interval character varying(10) NOT NULL,
    amount_cents integer NOT NULL,
    included_points integer DEFAULT 0 NOT NULL,
    bonus_points integer DEFAULT 0 NOT NULL,
    monthly_bonus_points integer DEFAULT 0 NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    payment_method character varying(40) DEFAULT 'alipay'::character varying NOT NULL,
    payment_txn_id character varying(255),
    provider_agreement_id character varying(255),
    client_request_id character varying(128),
    provider_request_id character varying(255),
    provider_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    paid_at timestamp with time zone,
    refunded_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    provider_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    payment_reconciliation_state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    payment_reconciliation_attempts integer DEFAULT 0 NOT NULL,
    next_payment_reconciliation_at timestamp with time zone,
    last_payment_reconciliation_at timestamp with time zone,
    last_payment_reconciliation_error character varying(500),
    payment_reconciliation_claimed_at timestamp with time zone,
    payment_reconciliation_lease_id uuid,
    payment_closed_at timestamp with time zone,
    CONSTRAINT subscription_orders_amount_cents_check CHECK ((amount_cents >= 0)),
    CONSTRAINT subscription_orders_billing_interval_check CHECK (((billing_interval)::text = ANY ((ARRAY['month'::character varying, 'year'::character varying])::text[]))),
    CONSTRAINT subscription_orders_order_type_check CHECK (((order_type)::text = ANY ((ARRAY['initial'::character varying, 'renewal'::character varying, 'upgrade'::character varying])::text[]))),
    CONSTRAINT subscription_orders_payment_reconciliation_attempts_check CHECK ((payment_reconciliation_attempts >= 0)),
    CONSTRAINT subscription_orders_payment_reconciliation_state_check CHECK (((payment_reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying, 'succeeded'::character varying, 'closed'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT subscription_orders_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'partially_refunded'::character varying, 'refunded'::character varying])::text[])))
);


--
-- Name: subscription_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_orders_id_seq OWNED BY public.subscription_orders.id;


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    id bigint NOT NULL,
    plan_key character varying(80) NOT NULL,
    plan_name character varying(120) NOT NULL,
    membership_tier character varying(20) NOT NULL,
    billing_interval character varying(10) NOT NULL,
    price_cents integer NOT NULL,
    included_points integer DEFAULT 0 NOT NULL,
    bonus_points integer DEFAULT 0 NOT NULL,
    monthly_bonus_points integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT subscription_plans_billing_interval_check CHECK (((billing_interval)::text = ANY ((ARRAY['month'::character varying, 'year'::character varying])::text[]))),
    CONSTRAINT subscription_plans_bonus_points_check CHECK ((bonus_points >= 0)),
    CONSTRAINT subscription_plans_included_points_check CHECK ((included_points >= 0)),
    CONSTRAINT subscription_plans_membership_tier_check CHECK (((membership_tier)::text = ANY ((ARRAY['basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[]))),
    CONSTRAINT subscription_plans_monthly_bonus_points_check CHECK ((monthly_bonus_points >= 0)),
    CONSTRAINT subscription_plans_price_cents_check CHECK ((price_cents > 0))
);


--
-- Name: subscription_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_plans_id_seq OWNED BY public.subscription_plans.id;


--
-- Name: subscription_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_refunds (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    refund_no character varying(80) NOT NULL,
    requested_points integer DEFAULT 0 NOT NULL,
    refunded_points integer DEFAULT 0 NOT NULL,
    amount_cents integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reason text,
    provider_refund_id character varying(255),
    idempotency_key character varying(128) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp with time zone,
    request_fingerprint character(64),
    reconciliation_state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    reconciliation_attempts integer DEFAULT 0 NOT NULL,
    next_reconciliation_at timestamp with time zone,
    last_reconciliation_at timestamp with time zone,
    last_reconciliation_error character varying(500),
    reconciliation_claimed_at timestamp with time zone,
    reconciliation_lease_id uuid,
    CONSTRAINT subscription_refunds_amount_cents_check CHECK ((amount_cents >= 0)),
    CONSTRAINT subscription_refunds_reconciliation_attempts_check CHECK ((reconciliation_attempts >= 0)),
    CONSTRAINT subscription_refunds_reconciliation_state_check CHECK (((reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'success'::character varying, 'failed'::character varying, 'uncertain'::character varying])::text[]))),
    CONSTRAINT subscription_refunds_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: subscription_refunds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_refunds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_refunds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_refunds_id_seq OWNED BY public.subscription_refunds.id;


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    plan_id bigint,
    plan_key character varying(80) NOT NULL,
    plan_name character varying(120) NOT NULL,
    membership_tier character varying(20) NOT NULL,
    billing_interval character varying(10) NOT NULL,
    price_cents integer NOT NULL,
    included_points integer DEFAULT 0 NOT NULL,
    bonus_points integer DEFAULT 0 NOT NULL,
    monthly_bonus_points integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    provider character varying(40) DEFAULT 'alipay'::character varying NOT NULL,
    provider_customer_id character varying(255),
    provider_agreement_id character varying(255),
    contact_email character varying(320),
    started_at timestamp with time zone,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    next_renewal_at timestamp with time zone,
    billing_anchor_day smallint,
    auto_renew boolean DEFAULT true NOT NULL,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    cancelled_at timestamp with time zone,
    last_reminder_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    scheduled_plan_id bigint,
    scheduled_plan_key character varying(80),
    scheduled_plan_name character varying(120),
    scheduled_membership_tier character varying(20),
    scheduled_billing_interval character varying(10),
    scheduled_price_cents integer,
    scheduled_included_points integer,
    scheduled_bonus_points integer,
    scheduled_monthly_bonus_points integer,
    scheduled_at timestamp with time zone,
    CONSTRAINT subscriptions_billing_anchor_day_check CHECK (((billing_anchor_day >= 1) AND (billing_anchor_day <= 31))),
    CONSTRAINT subscriptions_billing_interval_check CHECK (((billing_interval)::text = ANY ((ARRAY['month'::character varying, 'year'::character varying])::text[]))),
    CONSTRAINT subscriptions_membership_tier_check CHECK (((membership_tier)::text = ANY ((ARRAY['basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[]))),
    CONSTRAINT subscriptions_scheduled_interval_check CHECK (((scheduled_billing_interval IS NULL) OR ((scheduled_billing_interval)::text = ANY ((ARRAY['month'::character varying, 'year'::character varying])::text[])))),
    CONSTRAINT subscriptions_scheduled_tier_check CHECK (((scheduled_membership_tier IS NULL) OR ((scheduled_membership_tier)::text = ANY ((ARRAY['basic'::character varying, 'pro'::character varying, 'max'::character varying, 'enterprise'::character varying])::text[])))),
    CONSTRAINT subscriptions_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'past_due'::character varying, 'cancelled'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;


--
-- Name: user_content_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_content_uploads (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    object_key character varying(255) NOT NULL,
    asset_url text,
    media_type character varying(20) DEFAULT 'file'::character varying NOT NULL,
    mime_type character varying(160),
    original_name character varying(255),
    source_type character varying(32) DEFAULT 'upload'::character varying NOT NULL,
    source_resource_id character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT user_content_uploads_media_type_check CHECK (((media_type)::text = ANY ((ARRAY['image'::character varying, 'video'::character varying, 'audio'::character varying, 'file'::character varying])::text[])))
);


--
-- Name: user_content_uploads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_content_uploads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_content_uploads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_content_uploads_id_seq OWNED BY public.user_content_uploads.id;


--
-- Name: user_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_operations (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    action character varying(120) NOT NULL,
    target_type character varying(80) NOT NULL,
    target_id character varying(255) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(24) DEFAULT 'claimed'::character varying NOT NULL,
    response_snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT user_operations_completion_check CHECK (((((status)::text = 'claimed'::text) AND (response_snapshot IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'completed'::text) AND (response_snapshot IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT user_operations_key_check CHECK (((idempotency_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text)),
    CONSTRAINT user_operations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT user_operations_status_check CHECK (((status)::text = ANY ((ARRAY['claimed'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: user_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_operations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_operations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_operations_id_seq OWNED BY public.user_operations.id;


--
-- Name: user_point_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_point_accounts (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    balance_points integer DEFAULT 0 NOT NULL,
    held_points integer DEFAULT 0 NOT NULL,
    monthly_bonus_points integer DEFAULT 0 NOT NULL,
    membership_tier character varying(20) DEFAULT 'free'::character varying NOT NULL,
    bonus_cycle_anchor timestamp with time zone,
    last_bonus_granted_at timestamp with time zone,
    next_bonus_at timestamp with time zone,
    version integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT user_point_accounts_balance_points_check CHECK ((balance_points >= 0)),
    CONSTRAINT user_point_accounts_check CHECK ((balance_points >= held_points)),
    CONSTRAINT user_point_accounts_held_points_check CHECK ((held_points >= 0))
);


--
-- Name: user_point_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_point_accounts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_point_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_point_accounts_id_seq OWNED BY public.user_point_accounts.id;


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    user_id character varying(255) NOT NULL,
    display_name character varying(40),
    avatar_url text,
    avatar_object_key character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    email character varying(320),
    email_updated_at timestamp with time zone,
    account_status character varying(24) DEFAULT 'active'::character varying NOT NULL,
    deletion_requested_at timestamp with time zone,
    deletion_scheduled_at timestamp with time zone,
    app_role character varying(16) DEFAULT 'user'::character varying NOT NULL,
    role_updated_at timestamp with time zone,
    auth_valid_after timestamp with time zone DEFAULT to_timestamp((0)::double precision) NOT NULL,
    suspended_at timestamp with time zone,
    suspended_by character varying(255),
    suspension_reason text,
    last_seen_at timestamp with time zone,
    full_name character varying(120),
    gender character varying(32),
    birthdate date,
    CONSTRAINT user_profiles_account_status_check CHECK (((account_status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[]))),
    CONSTRAINT user_profiles_app_role_check CHECK (((app_role)::text = ANY ((ARRAY['root'::character varying, 'admin'::character varying, 'user'::character varying])::text[])))
);


--
-- Name: visual_parameter_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visual_parameter_options (
    id bigint NOT NULL,
    parameter_key character varying(40) NOT NULL,
    option_key character varying(80) NOT NULL,
    display_name character varying(160) NOT NULL,
    display_name_en character varying(160) NOT NULL,
    description character varying(1000),
    prompt_fragment character varying(1200) NOT NULL,
    negative_prompt_fragment character varying(1200),
    supported_output_types jsonb DEFAULT '["image", "video"]'::jsonb NOT NULL,
    model_keys jsonb DEFAULT '[]'::jsonb NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_user_id character varying(255),
    updated_by_user_id character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT visual_parameter_key_check CHECK (((parameter_key)::text ~ '^[a-z][a-z0-9_]{1,39}$'::text)),
    CONSTRAINT visual_parameter_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT visual_parameter_model_keys_check CHECK ((jsonb_typeof(model_keys) = 'array'::text)),
    CONSTRAINT visual_parameter_option_key_check CHECK (((option_key)::text ~ '^[a-z0-9][a-z0-9_-]{1,79}$'::text)),
    CONSTRAINT visual_parameter_output_types_check CHECK ((jsonb_typeof(supported_output_types) = 'array'::text))
);


--
-- Name: visual_parameter_options_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.visual_parameter_options_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: visual_parameter_options_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.visual_parameter_options_id_seq OWNED BY public.visual_parameter_options.id;


--
-- Name: workflow_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_events (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    node_key character varying(128),
    event_type character varying(80) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_events_id_seq OWNED BY public.workflow_events.id;


--
-- Name: workflow_loop_iterations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_loop_iterations (
    id bigint NOT NULL,
    parent_run_id bigint NOT NULL,
    parent_node_key character varying(128) NOT NULL,
    iteration_index integer NOT NULL,
    child_run_id bigint,
    item_snapshot jsonb,
    status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_loop_iterations_index_check CHECK (((iteration_index >= 0) AND (iteration_index <= 999))),
    CONSTRAINT workflow_loop_iterations_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: workflow_loop_iterations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_loop_iterations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_loop_iterations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_loop_iterations_id_seq OWNED BY public.workflow_loop_iterations.id;


--
-- Name: workflow_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_nodes (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    node_key character varying(128) NOT NULL,
    node_type character varying(80) NOT NULL,
    depends_on text[] DEFAULT ARRAY[]::text[] NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    points_estimate integer DEFAULT 0 NOT NULL,
    points_charged integer DEFAULT 0 NOT NULL,
    status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    result_snapshot jsonb,
    error_code character varying(120),
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT workflow_nodes_attempt_check CHECK ((attempt_count >= 0)),
    CONSTRAINT workflow_nodes_charged_check CHECK ((points_charged >= 0)),
    CONSTRAINT workflow_nodes_estimate_check CHECK ((points_estimate >= 0)),
    CONSTRAINT workflow_nodes_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'waiting_approval'::character varying, 'running'::character varying, 'completed'::character varying, 'paused'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: workflow_nodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_nodes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_nodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_nodes_id_seq OWNED BY public.workflow_nodes.id;


--
-- Name: workflow_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_runs (
    id bigint NOT NULL,
    user_id character varying(255) NOT NULL,
    canvas_id character varying(64),
    title character varying(160) DEFAULT 'Untitled workflow'::character varying NOT NULL,
    request_idempotency_key character varying(128) NOT NULL,
    request_hash character(64) NOT NULL,
    definition_snapshot jsonb NOT NULL,
    status character varying(24) DEFAULT 'queued'::character varying NOT NULL,
    estimated_points integer DEFAULT 0 NOT NULL,
    points_charged integer DEFAULT 0 NOT NULL,
    error_code character varying(120),
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    execution_lease_id bigint,
    terminal_notification_claimed_at timestamp with time zone,
    terminal_notification_sent_at timestamp with time zone,
    terminal_notification_skipped_at timestamp with time zone,
    terminal_notification_last_error character varying(120),
    workflow_id character varying(80),
    workflow_version integer,
    parent_run_id bigint,
    execution_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT workflow_runs_charged_check CHECK ((points_charged >= 0)),
    CONSTRAINT workflow_runs_estimate_check CHECK ((estimated_points >= 0)),
    CONSTRAINT workflow_runs_execution_context_check CHECK ((jsonb_typeof(execution_context) = 'object'::text)),
    CONSTRAINT workflow_runs_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_runs_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT workflow_runs_terminal_notification_outcome_check CHECK (((terminal_notification_sent_at IS NULL) OR (terminal_notification_skipped_at IS NULL)))
);


--
-- Name: workflow_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_runs_id_seq OWNED BY public.workflow_runs.id;


--
-- Name: administrator_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.administrator_audit_log ALTER COLUMN id SET DEFAULT nextval('public.administrator_audit_log_id_seq'::regclass);


--
-- Name: administrator_operations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.administrator_operations ALTER COLUMN id SET DEFAULT nextval('public.administrator_operations_id_seq'::regclass);


--
-- Name: agent_approval_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_approval_credentials ALTER COLUMN id SET DEFAULT nextval('public.agent_approval_credentials_id_seq'::regclass);


--
-- Name: agent_plan_steps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plan_steps ALTER COLUMN id SET DEFAULT nextval('public.agent_plan_steps_id_seq'::regclass);


--
-- Name: agent_skills id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_skills ALTER COLUMN id SET DEFAULT nextval('public.agent_skills_id_seq'::regclass);


--
-- Name: agent_tool_audit_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audit_events ALTER COLUMN id SET DEFAULT nextval('public.agent_tool_audit_events_id_seq'::regclass);


--
-- Name: agent_tools id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools ALTER COLUMN id SET DEFAULT nextval('public.agent_tools_id_seq'::regclass);


--
-- Name: announcements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements ALTER COLUMN id SET DEFAULT nextval('public.announcements_id_seq'::regclass);


--
-- Name: canvas_agent_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_events ALTER COLUMN id SET DEFAULT nextval('public.canvas_agent_events_id_seq'::regclass);


--
-- Name: canvas_agent_steps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_steps ALTER COLUMN id SET DEFAULT nextval('public.canvas_agent_steps_id_seq'::regclass);


--
-- Name: canvas_revisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_revisions ALTER COLUMN id SET DEFAULT nextval('public.canvas_revisions_id_seq'::regclass);


--
-- Name: community_creation_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_events ALTER COLUMN id SET DEFAULT nextval('public.community_creation_events_id_seq'::regclass);


--
-- Name: community_creation_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_reports ALTER COLUMN id SET DEFAULT nextval('public.community_creation_reports_id_seq'::regclass);


--
-- Name: content_object_cleanup_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_object_cleanup_jobs ALTER COLUMN id SET DEFAULT nextval('public.content_object_cleanup_jobs_id_seq'::regclass);


--
-- Name: content_recycle_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recycle_entries ALTER COLUMN id SET DEFAULT nextval('public.content_recycle_entries_id_seq'::regclass);


--
-- Name: content_recycle_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recycle_notifications ALTER COLUMN id SET DEFAULT nextval('public.content_recycle_notifications_id_seq'::regclass);


--
-- Name: content_restore_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_restore_requests ALTER COLUMN id SET DEFAULT nextval('public.content_restore_requests_id_seq'::regclass);


--
-- Name: creations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creations ALTER COLUMN id SET DEFAULT nextval('public.creations_id_seq'::regclass);


--
-- Name: digital_human_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_human_roles ALTER COLUMN id SET DEFAULT nextval('public.digital_human_roles_id_seq'::regclass);


--
-- Name: execution_governor_leases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_governor_leases ALTER COLUMN id SET DEFAULT nextval('public.execution_governor_leases_id_seq'::regclass);


--
-- Name: execution_governor_policies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_governor_policies ALTER COLUMN id SET DEFAULT nextval('public.execution_governor_policies_id_seq'::regclass);


--
-- Name: generation_charge_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_charge_rules ALTER COLUMN id SET DEFAULT nextval('public.generation_charge_rules_id_seq'::regclass);


--
-- Name: identity_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_links ALTER COLUMN id SET DEFAULT nextval('public.identity_links_id_seq'::regclass);


--
-- Name: invitation_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_codes ALTER COLUMN id SET DEFAULT nextval('public.invitation_codes_id_seq'::regclass);


--
-- Name: invitation_redemptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions ALTER COLUMN id SET DEFAULT nextval('public.invitation_redemptions_id_seq'::regclass);


--
-- Name: mcp_call_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_call_audit ALTER COLUMN id SET DEFAULT nextval('public.mcp_call_audit_id_seq'::regclass);


--
-- Name: mcp_connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections ALTER COLUMN id SET DEFAULT nextval('public.mcp_connections_id_seq'::regclass);


--
-- Name: mcp_oauth_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_transactions ALTER COLUMN id SET DEFAULT nextval('public.mcp_oauth_transactions_id_seq'::regclass);


--
-- Name: mcp_server_tools id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_server_tools ALTER COLUMN id SET DEFAULT nextval('public.mcp_server_tools_id_seq'::regclass);


--
-- Name: mcp_servers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers ALTER COLUMN id SET DEFAULT nextval('public.mcp_servers_id_seq'::regclass);


--
-- Name: membership_bonus_grants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_bonus_grants ALTER COLUMN id SET DEFAULT nextval('public.membership_bonus_grants_id_seq'::regclass);


--
-- Name: metered_agent_operations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metered_agent_operations ALTER COLUMN id SET DEFAULT nextval('public.metered_agent_operations_id_seq'::regclass);


--
-- Name: model_routes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_routes ALTER COLUMN id SET DEFAULT nextval('public.model_routes_id_seq'::regclass);


--
-- Name: oauth_client_registrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_client_registrations ALTER COLUMN id SET DEFAULT nextval('public.oauth_client_registrations_id_seq'::regclass);


--
-- Name: persistent_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persistent_jobs ALTER COLUMN id SET DEFAULT nextval('public.persistent_jobs_id_seq'::regclass);


--
-- Name: point_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_ledger ALTER COLUMN id SET DEFAULT nextval('public.point_ledger_id_seq'::regclass);


--
-- Name: point_lot_allocations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_lot_allocations ALTER COLUMN id SET DEFAULT nextval('public.point_lot_allocations_id_seq'::regclass);


--
-- Name: point_lots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_lots ALTER COLUMN id SET DEFAULT nextval('public.point_lots_id_seq'::regclass);


--
-- Name: point_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_orders ALTER COLUMN id SET DEFAULT nextval('public.point_orders_id_seq'::regclass);


--
-- Name: point_package_refunds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_package_refunds ALTER COLUMN id SET DEFAULT nextval('public.point_package_refunds_id_seq'::regclass);


--
-- Name: point_packages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_packages ALTER COLUMN id SET DEFAULT nextval('public.point_packages_id_seq'::regclass);


--
-- Name: prompt_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates ALTER COLUMN id SET DEFAULT nextval('public.prompt_templates_id_seq'::regclass);


--
-- Name: subscription_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_orders ALTER COLUMN id SET DEFAULT nextval('public.subscription_orders_id_seq'::regclass);


--
-- Name: subscription_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans ALTER COLUMN id SET DEFAULT nextval('public.subscription_plans_id_seq'::regclass);


--
-- Name: subscription_refunds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_refunds ALTER COLUMN id SET DEFAULT nextval('public.subscription_refunds_id_seq'::regclass);


--
-- Name: subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);


--
-- Name: user_content_uploads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_content_uploads ALTER COLUMN id SET DEFAULT nextval('public.user_content_uploads_id_seq'::regclass);


--
-- Name: user_operations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_operations ALTER COLUMN id SET DEFAULT nextval('public.user_operations_id_seq'::regclass);


--
-- Name: user_point_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_point_accounts ALTER COLUMN id SET DEFAULT nextval('public.user_point_accounts_id_seq'::regclass);


--
-- Name: visual_parameter_options id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_parameter_options ALTER COLUMN id SET DEFAULT nextval('public.visual_parameter_options_id_seq'::regclass);


--
-- Name: workflow_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events ALTER COLUMN id SET DEFAULT nextval('public.workflow_events_id_seq'::regclass);


--
-- Name: workflow_loop_iterations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_loop_iterations ALTER COLUMN id SET DEFAULT nextval('public.workflow_loop_iterations_id_seq'::regclass);


--
-- Name: workflow_nodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_nodes ALTER COLUMN id SET DEFAULT nextval('public.workflow_nodes_id_seq'::regclass);


--
-- Name: workflow_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs ALTER COLUMN id SET DEFAULT nextval('public.workflow_runs_id_seq'::regclass);


--
-- Name: administrator_audit_log administrator_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.administrator_audit_log
    ADD CONSTRAINT administrator_audit_log_pkey PRIMARY KEY (id);


--
-- Name: administrator_operations administrator_operations_actor_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.administrator_operations
    ADD CONSTRAINT administrator_operations_actor_key_unique UNIQUE (actor_user_id, idempotency_key);


--
-- Name: administrator_operations administrator_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.administrator_operations
    ADD CONSTRAINT administrator_operations_pkey PRIMARY KEY (id);


--
-- Name: agent_approval_credentials agent_approval_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_approval_credentials
    ADD CONSTRAINT agent_approval_credentials_pkey PRIMARY KEY (id);


--
-- Name: agent_approval_credentials agent_approval_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_approval_credentials
    ADD CONSTRAINT agent_approval_token_unique UNIQUE (token_digest);


--
-- Name: agent_conversations agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_pkey PRIMARY KEY (id);


--
-- Name: agent_plan_runs agent_plan_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plan_runs
    ADD CONSTRAINT agent_plan_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_plan_steps agent_plan_steps_call_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plan_steps
    ADD CONSTRAINT agent_plan_steps_call_unique UNIQUE (run_id, call_id);


--
-- Name: agent_plan_steps agent_plan_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plan_steps
    ADD CONSTRAINT agent_plan_steps_pkey PRIMARY KEY (id);


--
-- Name: agent_plan_steps agent_plan_steps_position_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plan_steps
    ADD CONSTRAINT agent_plan_steps_position_unique UNIQUE (run_id, "position");


--
-- Name: agent_skills agent_skills_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_skills
    ADD CONSTRAINT agent_skills_name_key UNIQUE (name);


--
-- Name: agent_skills agent_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_skills
    ADD CONSTRAINT agent_skills_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_audit_events agent_tool_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audit_events
    ADD CONSTRAINT agent_tool_audit_events_pkey PRIMARY KEY (id);


--
-- Name: agent_tools agent_tools_key_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_key_version_unique UNIQUE (tool_key, version);


--
-- Name: agent_tools agent_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_pkey PRIMARY KEY (id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: canvas_agent_conversations canvas_agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_conversations
    ADD CONSTRAINT canvas_agent_conversations_pkey PRIMARY KEY (id);


--
-- Name: canvas_agent_events canvas_agent_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_events
    ADD CONSTRAINT canvas_agent_events_pkey PRIMARY KEY (id);


--
-- Name: canvas_agent_runs canvas_agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_runs
    ADD CONSTRAINT canvas_agent_runs_pkey PRIMARY KEY (id);


--
-- Name: canvas_agent_steps canvas_agent_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_steps
    ADD CONSTRAINT canvas_agent_steps_pkey PRIMARY KEY (id);


--
-- Name: canvas_agent_steps canvas_agent_steps_position_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_steps
    ADD CONSTRAINT canvas_agent_steps_position_unique UNIQUE (run_id, "position");


--
-- Name: canvas_model_preferences canvas_model_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_model_preferences
    ADD CONSTRAINT canvas_model_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: canvas_revisions canvas_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_revisions
    ADD CONSTRAINT canvas_revisions_pkey PRIMARY KEY (id);


--
-- Name: canvas_revisions canvas_revisions_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_revisions
    ADD CONSTRAINT canvas_revisions_unique UNIQUE (canvas_id, version);


--
-- Name: canvas_workflow_versions canvas_workflow_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_workflow_versions
    ADD CONSTRAINT canvas_workflow_versions_pkey PRIMARY KEY (workflow_id, version);


--
-- Name: canvas_workflows canvas_workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_workflows
    ADD CONSTRAINT canvas_workflows_pkey PRIMARY KEY (id);


--
-- Name: canvases canvases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvases
    ADD CONSTRAINT canvases_pkey PRIMARY KEY (id);


--
-- Name: community_creation_events community_creation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_events
    ADD CONSTRAINT community_creation_events_pkey PRIMARY KEY (id);


--
-- Name: community_creation_favorites community_creation_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_favorites
    ADD CONSTRAINT community_creation_favorites_pkey PRIMARY KEY (creation_id, user_id);


--
-- Name: community_creation_likes community_creation_likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_likes
    ADD CONSTRAINT community_creation_likes_pkey PRIMARY KEY (creation_id, user_id);


--
-- Name: community_creation_reports community_creation_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_reports
    ADD CONSTRAINT community_creation_reports_pkey PRIMARY KEY (id);


--
-- Name: content_object_cleanup_jobs content_object_cleanup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_object_cleanup_jobs
    ADD CONSTRAINT content_object_cleanup_jobs_pkey PRIMARY KEY (id);


--
-- Name: content_recycle_entries content_recycle_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recycle_entries
    ADD CONSTRAINT content_recycle_entries_pkey PRIMARY KEY (id);


--
-- Name: content_recycle_notifications content_recycle_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_recycle_notifications
    ADD CONSTRAINT content_recycle_notifications_pkey PRIMARY KEY (id);


--
-- Name: content_restore_requests content_restore_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_restore_requests
    ADD CONSTRAINT content_restore_requests_pkey PRIMARY KEY (id);


--
-- Name: creations creations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creations
    ADD CONSTRAINT creations_pkey PRIMARY KEY (id);


--
-- Name: digital_human_roles digital_human_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_human_roles
    ADD CONSTRAINT digital_human_roles_pkey PRIMARY KEY (id);


--
-- Name: digital_human_roles digital_human_roles_qr_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_human_roles
    ADD CONSTRAINT digital_human_roles_qr_token_key UNIQUE (qr_token);


--
-- Name: execution_governor_leases execution_governor_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_governor_leases
    ADD CONSTRAINT execution_governor_leases_pkey PRIMARY KEY (id);


--
-- Name: execution_governor_policies execution_governor_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_governor_policies
    ADD CONSTRAINT execution_governor_policies_pkey PRIMARY KEY (id);


--
-- Name: execution_governor_policies execution_governor_policy_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_governor_policies
    ADD CONSTRAINT execution_governor_policy_unique UNIQUE (membership_tier, operation_key);


--
-- Name: generation_charge_rules generation_charge_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_charge_rules
    ADD CONSTRAINT generation_charge_rules_pkey PRIMARY KEY (id);


--
-- Name: global_agent_preferences global_agent_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_agent_preferences
    ADD CONSTRAINT global_agent_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: identity_links identity_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_links
    ADD CONSTRAINT identity_links_pkey PRIMARY KEY (id);


--
-- Name: invitation_codes invitation_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_codes
    ADD CONSTRAINT invitation_codes_code_key UNIQUE (code);


--
-- Name: invitation_codes invitation_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_codes
    ADD CONSTRAINT invitation_codes_pkey PRIMARY KEY (id);


--
-- Name: invitation_redemptions invitation_redemptions_code_invitee_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_code_invitee_unique UNIQUE (code_id, invitee_user_id);


--
-- Name: invitation_redemptions invitation_redemptions_invitee_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_invitee_unique UNIQUE (invitee_user_id);


--
-- Name: invitation_redemptions invitation_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_pkey PRIMARY KEY (id);


--
-- Name: invitation_settings invitation_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_settings
    ADD CONSTRAINT invitation_settings_pkey PRIMARY KEY (id);


--
-- Name: mcp_call_audit mcp_call_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_call_audit
    ADD CONSTRAINT mcp_call_audit_pkey PRIMARY KEY (id);


--
-- Name: mcp_connections mcp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_pkey PRIMARY KEY (id);


--
-- Name: mcp_connections mcp_connections_unique_account; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_unique_account UNIQUE (user_id, mcp_server_id, provider_account_id);


--
-- Name: mcp_oauth_transactions mcp_oauth_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_transactions
    ADD CONSTRAINT mcp_oauth_transactions_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_transactions mcp_oauth_transactions_state_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_transactions
    ADD CONSTRAINT mcp_oauth_transactions_state_hash_key UNIQUE (state_hash);


--
-- Name: mcp_server_tools mcp_server_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_server_tools
    ADD CONSTRAINT mcp_server_tools_pkey PRIMARY KEY (id);


--
-- Name: mcp_server_tools mcp_server_tools_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_server_tools
    ADD CONSTRAINT mcp_server_tools_unique UNIQUE (server_id, tool_name);


--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: mcp_servers mcp_servers_server_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_server_key_key UNIQUE (server_key);


--
-- Name: membership_bonus_grants membership_bonus_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_bonus_grants
    ADD CONSTRAINT membership_bonus_grants_pkey PRIMARY KEY (id);


--
-- Name: metered_agent_operations metered_agent_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metered_agent_operations
    ADD CONSTRAINT metered_agent_operations_pkey PRIMARY KEY (id);


--
-- Name: metered_agent_operations metered_agent_operations_user_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metered_agent_operations
    ADD CONSTRAINT metered_agent_operations_user_key_unique UNIQUE (user_id, request_idempotency_key);


--
-- Name: model_catalog model_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_catalog
    ADD CONSTRAINT model_catalog_pkey PRIMARY KEY (model_key);


--
-- Name: model_routes model_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_routes
    ADD CONSTRAINT model_routes_pkey PRIMARY KEY (id);


--
-- Name: model_routes model_routes_unique_target; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_routes
    ADD CONSTRAINT model_routes_unique_target UNIQUE (model_key, provider_key, upstream_model_id);


--
-- Name: oauth_client_registrations oauth_client_registration_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_client_registrations
    ADD CONSTRAINT oauth_client_registration_unique UNIQUE (mcp_server_id, issuer);


--
-- Name: oauth_client_registrations oauth_client_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_client_registrations
    ADD CONSTRAINT oauth_client_registrations_pkey PRIMARY KEY (id);


--
-- Name: persistent_jobs persistent_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persistent_jobs
    ADD CONSTRAINT persistent_jobs_pkey PRIMARY KEY (id);


--
-- Name: point_ledger point_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_ledger
    ADD CONSTRAINT point_ledger_pkey PRIMARY KEY (id);


--
-- Name: point_lot_allocations point_lot_allocations_creation_id_lot_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_lot_allocations
    ADD CONSTRAINT point_lot_allocations_creation_id_lot_id_key UNIQUE (creation_id, lot_id);


--
-- Name: point_lot_allocations point_lot_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_lot_allocations
    ADD CONSTRAINT point_lot_allocations_pkey PRIMARY KEY (id);


--
-- Name: point_lots point_lots_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_lots
    ADD CONSTRAINT point_lots_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: point_lots point_lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_lots
    ADD CONSTRAINT point_lots_pkey PRIMARY KEY (id);


--
-- Name: point_orders point_orders_order_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_orders
    ADD CONSTRAINT point_orders_order_no_key UNIQUE (order_no);


--
-- Name: point_orders point_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_orders
    ADD CONSTRAINT point_orders_pkey PRIMARY KEY (id);


--
-- Name: point_package_refunds point_package_refunds_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_package_refunds
    ADD CONSTRAINT point_package_refunds_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: point_package_refunds point_package_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_package_refunds
    ADD CONSTRAINT point_package_refunds_pkey PRIMARY KEY (id);


--
-- Name: point_package_refunds point_package_refunds_refund_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_package_refunds
    ADD CONSTRAINT point_package_refunds_refund_no_key UNIQUE (refund_no);


--
-- Name: point_packages point_packages_package_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_packages
    ADD CONSTRAINT point_packages_package_key_key UNIQUE (package_key);


--
-- Name: point_packages point_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_packages
    ADD CONSTRAINT point_packages_pkey PRIMARY KEY (id);


--
-- Name: prompt_templates prompt_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates
    ADD CONSTRAINT prompt_templates_pkey PRIMARY KEY (id);


--
-- Name: prompt_templates prompt_templates_scene_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates
    ADD CONSTRAINT prompt_templates_scene_key_key UNIQUE (scene_key);


--
-- Name: schema_migrations schema_migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_filename_key UNIQUE (filename);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: subscription_orders subscription_orders_order_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_orders
    ADD CONSTRAINT subscription_orders_order_no_key UNIQUE (order_no);


--
-- Name: subscription_orders subscription_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_orders
    ADD CONSTRAINT subscription_orders_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_plan_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_plan_key_key UNIQUE (plan_key);


--
-- Name: subscription_refunds subscription_refunds_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_refunds
    ADD CONSTRAINT subscription_refunds_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: subscription_refunds subscription_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_refunds
    ADD CONSTRAINT subscription_refunds_pkey PRIMARY KEY (id);


--
-- Name: subscription_refunds subscription_refunds_refund_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_refunds
    ADD CONSTRAINT subscription_refunds_refund_no_key UNIQUE (refund_no);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: creations uq_creations_user_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creations
    ADD CONSTRAINT uq_creations_user_idempotency UNIQUE (user_id, request_idempotency_key);


--
-- Name: user_content_uploads user_content_uploads_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_content_uploads
    ADD CONSTRAINT user_content_uploads_object_key_key UNIQUE (object_key);


--
-- Name: user_content_uploads user_content_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_content_uploads
    ADD CONSTRAINT user_content_uploads_pkey PRIMARY KEY (id);


--
-- Name: user_operations user_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_operations
    ADD CONSTRAINT user_operations_pkey PRIMARY KEY (id);


--
-- Name: user_operations user_operations_user_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_operations
    ADD CONSTRAINT user_operations_user_key_unique UNIQUE (user_id, idempotency_key);


--
-- Name: user_point_accounts user_point_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_point_accounts
    ADD CONSTRAINT user_point_accounts_pkey PRIMARY KEY (id);


--
-- Name: user_point_accounts user_point_accounts_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_point_accounts
    ADD CONSTRAINT user_point_accounts_user_id_key UNIQUE (user_id);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: visual_parameter_options visual_parameter_option_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_parameter_options
    ADD CONSTRAINT visual_parameter_option_unique UNIQUE (parameter_key, option_key);


--
-- Name: visual_parameter_options visual_parameter_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visual_parameter_options
    ADD CONSTRAINT visual_parameter_options_pkey PRIMARY KEY (id);


--
-- Name: workflow_events workflow_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events
    ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (id);


--
-- Name: workflow_loop_iterations workflow_loop_iterations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_loop_iterations
    ADD CONSTRAINT workflow_loop_iterations_pkey PRIMARY KEY (id);


--
-- Name: workflow_loop_iterations workflow_loop_iterations_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_loop_iterations
    ADD CONSTRAINT workflow_loop_iterations_unique UNIQUE (parent_run_id, parent_node_key, iteration_index);


--
-- Name: workflow_nodes workflow_nodes_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_nodes
    ADD CONSTRAINT workflow_nodes_key_unique UNIQUE (run_id, node_key);


--
-- Name: workflow_nodes workflow_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_nodes
    ADD CONSTRAINT workflow_nodes_pkey PRIMARY KEY (id);


--
-- Name: workflow_runs workflow_runs_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_key_unique UNIQUE (user_id, request_idempotency_key);


--
-- Name: workflow_runs workflow_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);


--
-- Name: idx_administrator_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_administrator_audit_actor ON public.administrator_audit_log USING btree (actor_user_id, created_at DESC);


--
-- Name: idx_administrator_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_administrator_audit_created ON public.administrator_audit_log USING btree (created_at DESC, id DESC);


--
-- Name: idx_administrator_audit_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_administrator_audit_target ON public.administrator_audit_log USING btree (target_type, target_id, created_at DESC);


--
-- Name: idx_administrator_operations_claimed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_administrator_operations_claimed ON public.administrator_operations USING btree (updated_at, id) WHERE ((status)::text = 'claimed'::text);


--
-- Name: idx_administrator_operations_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_administrator_operations_target ON public.administrator_operations USING btree (target_type, target_id, created_at DESC);


--
-- Name: idx_agent_approval_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_approval_expiry ON public.agent_approval_credentials USING btree (expires_at) WHERE ((status)::text = 'issued'::text);


--
-- Name: idx_agent_approval_user_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_approval_user_session ON public.agent_approval_credentials USING btree (user_id, session_id, created_at DESC);


--
-- Name: idx_agent_conversations_active_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_conversations_active_history ON public.agent_conversations USING btree (user_id, surface, updated_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_agent_conversations_canvas_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_conversations_canvas_history ON public.agent_conversations USING btree (user_id, canvas_id, updated_at DESC, id DESC) WHERE ((surface)::text = 'canvas'::text);


--
-- Name: idx_agent_conversations_user_surface_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_conversations_user_surface_history ON public.agent_conversations USING btree (user_id, surface, updated_at DESC, id DESC);


--
-- Name: idx_agent_plan_runs_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_plan_runs_active ON public.agent_plan_runs USING btree (status, updated_at, id) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting_approval'::character varying, 'waiting_client'::character varying])::text[]));


--
-- Name: idx_agent_plan_runs_request_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agent_plan_runs_request_idempotency ON public.agent_plan_runs USING btree (user_id, request_idempotency_key);


--
-- Name: idx_agent_plan_runs_user_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_plan_runs_user_history ON public.agent_plan_runs USING btree (user_id, created_at DESC, id DESC);


--
-- Name: idx_agent_plan_steps_run_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_plan_steps_run_position ON public.agent_plan_steps USING btree (run_id, "position");


--
-- Name: idx_agent_skills_catalog; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_skills_catalog ON public.agent_skills USING btree (status, updated_at DESC, id DESC);


--
-- Name: idx_agent_tool_audit_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tool_audit_session ON public.agent_tool_audit_events USING btree (session_id, created_at DESC, id DESC);


--
-- Name: idx_agent_tool_audit_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tool_audit_tool ON public.agent_tool_audit_events USING btree (tool_key, created_at DESC, id DESC);


--
-- Name: idx_agent_tool_audit_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tool_audit_user_created ON public.agent_tool_audit_events USING btree (user_id, created_at DESC, id DESC);


--
-- Name: idx_agent_tools_enabled_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agent_tools_enabled_key ON public.agent_tools USING btree (tool_key) WHERE enabled;


--
-- Name: idx_announcements_admin_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcements_admin_list ON public.announcements USING btree (deleted_at, status, updated_at DESC, id DESC);


--
-- Name: idx_announcements_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcements_created_by ON public.announcements USING btree (created_by, created_at DESC, id DESC);


--
-- Name: idx_announcements_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcements_published ON public.announcements USING btree (priority DESC, published_at DESC, id DESC) WHERE (((status)::text = 'published'::text) AND (deleted_at IS NULL));


--
-- Name: idx_canvas_agent_conversations_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvas_agent_conversations_history ON public.canvas_agent_conversations USING btree (user_id, canvas_id, updated_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: idx_canvas_agent_events_stream; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvas_agent_events_stream ON public.canvas_agent_events USING btree (run_id, id);


--
-- Name: idx_canvas_agent_runs_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvas_agent_runs_active ON public.canvas_agent_runs USING btree (status, updated_at, id) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting_approval'::character varying, 'waiting_external'::character varying])::text[]));


--
-- Name: idx_canvas_agent_runs_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvas_agent_runs_conversation ON public.canvas_agent_runs USING btree (conversation_id, created_at DESC, id DESC);


--
-- Name: idx_canvas_agent_runs_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_canvas_agent_runs_idempotency ON public.canvas_agent_runs USING btree (user_id, request_idempotency_key);


--
-- Name: idx_canvas_agent_steps_execution_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_canvas_agent_steps_execution_key ON public.canvas_agent_steps USING btree (execution_idempotency_key);


--
-- Name: idx_canvas_agent_steps_run_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvas_agent_steps_run_position ON public.canvas_agent_steps USING btree (run_id, "position");


--
-- Name: idx_canvas_revisions_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvas_revisions_history ON public.canvas_revisions USING btree (user_id, canvas_id, version DESC);


--
-- Name: idx_canvas_workflows_canvas_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_canvas_workflows_canvas_name_active ON public.canvas_workflows USING btree (user_id, canvas_id, lower((name)::text)) WHERE (archived_at IS NULL);


--
-- Name: idx_canvas_workflows_canvas_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvas_workflows_canvas_updated ON public.canvas_workflows USING btree (user_id, canvas_id, updated_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: idx_canvases_user_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canvases_user_updated_at ON public.canvases USING btree (user_id, updated_at DESC);


--
-- Name: idx_community_creation_events_creation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_creation_events_creation ON public.community_creation_events USING btree (creation_id, created_at DESC, id DESC);


--
-- Name: idx_community_creation_favorites_creation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_creation_favorites_creation ON public.community_creation_favorites USING btree (creation_id, created_at DESC);


--
-- Name: idx_community_creation_likes_creation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_creation_likes_creation ON public.community_creation_likes USING btree (creation_id, created_at DESC);


--
-- Name: idx_community_creation_reports_pending_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_community_creation_reports_pending_user ON public.community_creation_reports USING btree (creation_id, reporter_user_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_community_creation_reports_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_creation_reports_queue ON public.community_creation_reports USING btree (status, created_at DESC);


--
-- Name: idx_content_object_cleanup_jobs_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_object_cleanup_jobs_retry ON public.content_object_cleanup_jobs USING btree (next_attempt_at, id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'failed'::character varying])::text[]));


--
-- Name: idx_content_object_cleanup_jobs_stuck; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_object_cleanup_jobs_stuck ON public.content_object_cleanup_jobs USING btree (processing_started_at, id) WHERE ((status)::text = 'processing'::text);


--
-- Name: idx_content_recycle_entries_active_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_content_recycle_entries_active_resource ON public.content_recycle_entries USING btree (resource_type, resource_id) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_content_recycle_entries_admin_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_recycle_entries_admin_active ON public.content_recycle_entries USING btree (purge_after, deleted_at DESC) WHERE (((status)::text = 'active'::text) AND ((visibility)::text = 'admin_only'::text));


--
-- Name: idx_content_recycle_entries_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_recycle_entries_user_active ON public.content_recycle_entries USING btree (owner_user_id, purge_after, deleted_at DESC) WHERE (((status)::text = 'active'::text) AND ((visibility)::text = 'user'::text));


--
-- Name: idx_content_recycle_entries_user_purge; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_recycle_entries_user_purge ON public.content_recycle_entries USING btree (purge_after, id) WHERE (((status)::text = 'active'::text) AND ((visibility)::text = 'user'::text) AND ((deletion_origin)::text = 'user'::text));


--
-- Name: idx_content_recycle_notifications_user_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_recycle_notifications_user_created_at ON public.content_recycle_notifications USING btree (user_id, created_at DESC);


--
-- Name: idx_content_restore_requests_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_content_restore_requests_one_pending ON public.content_restore_requests USING btree (recycle_entry_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_content_restore_requests_requester_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_content_restore_requests_requester_idempotency ON public.content_restore_requests USING btree (requested_by_user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_content_restore_requests_status_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_restore_requests_status_created_at ON public.content_restore_requests USING btree (status, created_at);


--
-- Name: idx_creations_community_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creations_community_feed ON public.creations USING btree (community_featured DESC, community_published_at DESC, id DESC) WHERE (((status)::text = 'completed'::text) AND ((community_status)::text = 'public'::text) AND (community_hidden = false));


--
-- Name: idx_creations_completion_notification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creations_completion_notification ON public.creations USING btree (status, updated_at) WHERE (((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying])::text[])) AND (completion_notification_sent_at IS NULL) AND (completion_notification_skipped_at IS NULL));


--
-- Name: idx_creations_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creations_expires_at ON public.creations USING btree (expires_at);


--
-- Name: idx_creations_provider_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_creations_provider_task_id ON public.creations USING btree (provider, task_id) WHERE (task_id IS NOT NULL);


--
-- Name: idx_creations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creations_status ON public.creations USING btree (status);


--
-- Name: idx_creations_user_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_creations_user_created_at ON public.creations USING btree (user_id, created_at DESC);


--
-- Name: idx_creations_user_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_creations_user_idempotency_key ON public.creations USING btree (user_id, request_idempotency_key) WHERE (request_idempotency_key IS NOT NULL);


--
-- Name: idx_digital_human_roles_capture_token_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_human_roles_capture_token_active ON public.digital_human_roles USING btree (qr_token, qr_token_expires_at) WHERE ((qr_token_revoked_at IS NULL) AND (qr_token_consumed_at IS NULL));


--
-- Name: idx_digital_human_roles_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_human_roles_status ON public.digital_human_roles USING btree (status);


--
-- Name: idx_digital_human_roles_user_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_human_roles_user_created_at ON public.digital_human_roles USING btree (user_id, created_at DESC);


--
-- Name: idx_execution_governor_lease_counts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_execution_governor_lease_counts ON public.execution_governor_leases USING btree (user_id, operation_key, state, created_at DESC);


--
-- Name: idx_execution_governor_lease_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_execution_governor_lease_expiry ON public.execution_governor_leases USING btree (state, expires_at) WHERE ((state)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[]));


--
-- Name: idx_execution_governor_lease_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_execution_governor_lease_idempotency ON public.execution_governor_leases USING btree (user_id, operation_key, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_execution_governor_policy_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_execution_governor_policy_lookup ON public.execution_governor_policies USING btree (membership_tier, operation_key, enabled);


--
-- Name: idx_generation_charge_rules_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generation_charge_rules_lookup ON public.generation_charge_rules USING btree (output_type, provider, scene_key, is_active, priority);


--
-- Name: idx_generation_charge_rules_mode_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_generation_charge_rules_mode_lookup ON public.generation_charge_rules USING btree (output_type, provider, generation_mode, is_active, priority);


--
-- Name: idx_identity_links_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_identity_links_external ON public.identity_links USING btree (provider, issuer, subject);


--
-- Name: idx_identity_links_provider_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_identity_links_provider_user ON public.identity_links USING btree (provider, stardraw_user_id);


--
-- Name: idx_identity_links_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_links_username ON public.identity_links USING btree (lower((username)::text)) WHERE (username IS NOT NULL);


--
-- Name: idx_identity_links_verified_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_links_verified_email ON public.identity_links USING btree (lower((email)::text)) WHERE ((email IS NOT NULL) AND (email_verified_at IS NOT NULL));


--
-- Name: idx_invitation_codes_active_personal_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_invitation_codes_active_personal_owner ON public.invitation_codes USING btree (owner_user_id) WHERE (((code_type)::text = 'personal'::text) AND (is_active = true));


--
-- Name: idx_invitation_codes_common_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_codes_common_active ON public.invitation_codes USING btree (is_active, created_at DESC) WHERE ((code_type)::text = 'common'::text);


--
-- Name: idx_invitation_redemptions_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_redemptions_code ON public.invitation_redemptions USING btree (code_id, created_at DESC);


--
-- Name: idx_invitation_redemptions_inviter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_redemptions_inviter ON public.invitation_redemptions USING btree (inviter_user_id, created_at DESC) WHERE (inviter_user_id IS NOT NULL);


--
-- Name: idx_mcp_call_audit_server_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_call_audit_server_tool ON public.mcp_call_audit USING btree (mcp_server_id, tool_name, created_at DESC);


--
-- Name: idx_mcp_call_audit_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_call_audit_user_created ON public.mcp_call_audit USING btree (user_id, created_at DESC, id DESC);


--
-- Name: idx_mcp_connections_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_connections_user_status ON public.mcp_connections USING btree (user_id, status, updated_at DESC);


--
-- Name: idx_mcp_oauth_transactions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_transactions_expiry ON public.mcp_oauth_transactions USING btree (expires_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_mcp_oauth_transactions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_transactions_user ON public.mcp_oauth_transactions USING btree (user_id, created_at DESC);


--
-- Name: idx_mcp_server_tools_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_server_tools_enabled ON public.mcp_server_tools USING btree (server_id, enabled, tool_name);


--
-- Name: idx_mcp_servers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_servers_status ON public.mcp_servers USING btree (enabled, status, server_key);


--
-- Name: idx_membership_bonus_grants_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_membership_bonus_grants_idempotency_key ON public.membership_bonus_grants USING btree (idempotency_key);


--
-- Name: idx_membership_bonus_grants_user_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_membership_bonus_grants_user_cycle ON public.membership_bonus_grants USING btree (user_id, cycle_start_at);


--
-- Name: idx_metered_agent_operations_billing_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metered_agent_operations_billing_state ON public.metered_agent_operations USING btree (status, updated_at, id) WHERE ((status)::text = 'settlement_pending'::text);


--
-- Name: idx_metered_agent_operations_reconciliation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metered_agent_operations_reconciliation ON public.metered_agent_operations USING btree (status, updated_at, id) WHERE ((status)::text = 'reserved'::text);


--
-- Name: idx_metered_agent_operations_settlement_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metered_agent_operations_settlement_pending ON public.metered_agent_operations USING btree (updated_at, id) WHERE (((status)::text = 'settlement_pending'::text) AND (provider_completed_at IS NOT NULL));


--
-- Name: idx_model_catalog_active_display; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_catalog_active_display ON public.model_catalog USING btree (output_type, is_active, display_order, model_key);


--
-- Name: idx_model_routes_resolution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_routes_resolution ON public.model_routes USING btree (model_key, is_active, priority, id);


--
-- Name: idx_persistent_jobs_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persistent_jobs_claimable ON public.persistent_jobs USING btree (queue_name, priority DESC, available_at, id) WHERE ((status)::text = 'queued'::text);


--
-- Name: idx_persistent_jobs_expired_leases; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persistent_jobs_expired_leases ON public.persistent_jobs USING btree (queue_name, lease_expires_at, id) WHERE ((status)::text = 'running'::text);


--
-- Name: idx_persistent_jobs_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_persistent_jobs_idempotency ON public.persistent_jobs USING btree (queue_name, COALESCE(user_id, ''::character varying), idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_persistent_jobs_pending_dead_letter_alert; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persistent_jobs_pending_dead_letter_alert ON public.persistent_jobs USING btree (queue_name, updated_at, id) WHERE (((status)::text = 'failed'::text) AND (dead_letter_alerted_at IS NULL));


--
-- Name: idx_persistent_jobs_pending_user_notification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persistent_jobs_pending_user_notification ON public.persistent_jobs USING btree (queue_name, updated_at, id) WHERE (((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying])::text[])) AND (user_notification_sent_at IS NULL) AND (user_notification_skipped_at IS NULL));


--
-- Name: idx_persistent_jobs_user_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persistent_jobs_user_history ON public.persistent_jobs USING btree (user_id, created_at DESC, id DESC);


--
-- Name: idx_point_ledger_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_point_ledger_idempotency_key ON public.point_ledger USING btree (idempotency_key);


--
-- Name: idx_point_ledger_user_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_ledger_user_created_at ON public.point_ledger USING btree (user_id, created_at DESC);


--
-- Name: idx_point_lot_allocations_creation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_lot_allocations_creation ON public.point_lot_allocations USING btree (creation_id, status);


--
-- Name: idx_point_lot_allocations_lot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_lot_allocations_lot ON public.point_lot_allocations USING btree (lot_id, status);


--
-- Name: idx_point_lot_allocations_source_lot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_point_lot_allocations_source_lot ON public.point_lot_allocations USING btree (source_type, source_id, lot_id);


--
-- Name: idx_point_lot_allocations_source_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_lot_allocations_source_status ON public.point_lot_allocations USING btree (user_id, source_type, source_id, status);


--
-- Name: idx_point_lots_product_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_lots_product_order ON public.point_lots USING btree (product_order_type, product_order_id, expires_at, id) WHERE (product_order_type IS NOT NULL);


--
-- Name: idx_point_lots_user_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_lots_user_available ON public.point_lots USING btree (user_id, expires_at, created_at, id);


--
-- Name: idx_point_orders_payment_reconciliation_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_orders_payment_reconciliation_due ON public.point_orders USING btree (COALESCE(next_payment_reconciliation_at, created_at), id) WHERE (((status)::text = 'pending'::text) AND ((payment_reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying])::text[])));


--
-- Name: idx_point_orders_payment_txn_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_point_orders_payment_txn_id ON public.point_orders USING btree (payment_txn_id) WHERE (payment_txn_id IS NOT NULL);


--
-- Name: idx_point_orders_user_client_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_point_orders_user_client_request_id ON public.point_orders USING btree (user_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: idx_point_orders_user_confirm_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_point_orders_user_confirm_request_id ON public.point_orders USING btree (user_id, confirm_request_id) WHERE (confirm_request_id IS NOT NULL);


--
-- Name: idx_point_package_refunds_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_package_refunds_due ON public.point_package_refunds USING btree (COALESCE(next_reconciliation_at, created_at), id) WHERE (((status)::text = 'pending'::text) AND ((reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying])::text[])));


--
-- Name: idx_point_packages_active_display; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_point_packages_active_display ON public.point_packages USING btree (is_active, display_order, price_cents, id);


--
-- Name: idx_prompt_templates_catalog; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_templates_catalog ON public.prompt_templates USING btree (is_active, visibility, approval_status, required_membership_tier, display_order);


--
-- Name: idx_prompt_templates_marketplace_search_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_templates_marketplace_search_trgm ON public.prompt_templates USING gin (lower((((((((((((((COALESCE(scene_key, ''::character varying))::text || ' '::text) || (COALESCE(scene_name, ''::character varying))::text) || ' '::text) || (COALESCE(preview_title, ''::character varying))::text) || ' '::text) || COALESCE(preview_description, ''::text)) || ' '::text) || COALESCE(starter_prompt, ''::text)) || ' '::text) || (COALESCE(source_key, ''::character varying))::text) || ' '::text) || COALESCE((catalog_metadata ->> 'category'::text), ''::text))) public.gin_trgm_ops) WHERE (is_active = true);


--
-- Name: idx_prompt_templates_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_templates_owner ON public.prompt_templates USING btree (owner_user_id, is_active, updated_at DESC);


--
-- Name: idx_prompt_templates_source_catalog; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_templates_source_catalog ON public.prompt_templates USING btree (source_key, is_active, display_order, id) WHERE (source_key IS NOT NULL);


--
-- Name: idx_prompt_templates_source_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_prompt_templates_source_item ON public.prompt_templates USING btree (source_key, source_item_id);


--
-- Name: idx_subscription_orders_payment_reconciliation_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_orders_payment_reconciliation_due ON public.subscription_orders USING btree (COALESCE(next_payment_reconciliation_at, created_at), id) WHERE (((status)::text = 'pending'::text) AND ((payment_reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying])::text[])));


--
-- Name: idx_subscription_orders_payment_reconciliation_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_orders_payment_reconciliation_lease ON public.subscription_orders USING btree (payment_reconciliation_claimed_at, id) WHERE (((status)::text = 'pending'::text) AND ((payment_reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying])::text[])));


--
-- Name: idx_subscription_orders_payment_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_subscription_orders_payment_txn ON public.subscription_orders USING btree (payment_txn_id) WHERE (payment_txn_id IS NOT NULL);


--
-- Name: idx_subscription_orders_user_client_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_subscription_orders_user_client_request ON public.subscription_orders USING btree (user_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: idx_subscription_orders_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_orders_user_created ON public.subscription_orders USING btree (user_id, created_at DESC);


--
-- Name: idx_subscription_plans_active_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_plans_active_order ON public.subscription_plans USING btree (is_active, display_order, price_cents);


--
-- Name: idx_subscription_refunds_reconciliation_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_refunds_reconciliation_due ON public.subscription_refunds USING btree (COALESCE(next_reconciliation_at, created_at), id) WHERE (((status)::text = 'pending'::text) AND ((reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying])::text[])));


--
-- Name: idx_subscription_refunds_reconciliation_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_refunds_reconciliation_lease ON public.subscription_refunds USING btree (reconciliation_claimed_at, id) WHERE (((status)::text = 'pending'::text) AND ((reconciliation_state)::text = ANY ((ARRAY['pending'::character varying, 'uncertain'::character varying])::text[])));


--
-- Name: idx_subscriptions_one_live_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_subscriptions_one_live_per_user ON public.subscriptions USING btree (user_id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'past_due'::character varying])::text[]));


--
-- Name: idx_subscriptions_renewal_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_renewal_due ON public.subscriptions USING btree (status, auto_renew, next_renewal_at);


--
-- Name: idx_subscriptions_scheduled_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_scheduled_plan ON public.subscriptions USING btree (status, scheduled_at) WHERE (scheduled_plan_key IS NOT NULL);


--
-- Name: idx_subscriptions_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user_status ON public.subscriptions USING btree (user_id, status, current_period_end DESC);


--
-- Name: idx_user_content_uploads_user_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_content_uploads_user_created_at ON public.user_content_uploads USING btree (user_id, created_at DESC);


--
-- Name: idx_user_operations_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_operations_target ON public.user_operations USING btree (target_type, target_id, created_at DESC);


--
-- Name: idx_user_profiles_role_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_role_status ON public.user_profiles USING btree (app_role, account_status, updated_at DESC);


--
-- Name: idx_user_profiles_single_root; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_profiles_single_root ON public.user_profiles USING btree (app_role) WHERE ((app_role)::text = 'root'::text);


--
-- Name: idx_visual_parameter_active_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_visual_parameter_active_order ON public.visual_parameter_options USING btree (parameter_key, is_active, display_order, option_key);


--
-- Name: idx_workflow_events_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_events_run ON public.workflow_events USING btree (run_id, id);


--
-- Name: idx_workflow_loop_iterations_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_loop_iterations_parent ON public.workflow_loop_iterations USING btree (parent_run_id, parent_node_key, iteration_index);


--
-- Name: idx_workflow_nodes_dependencies; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_nodes_dependencies ON public.workflow_nodes USING gin (depends_on);


--
-- Name: idx_workflow_nodes_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_nodes_ready ON public.workflow_nodes USING btree (run_id, status, updated_at, id);


--
-- Name: idx_workflow_runs_definition_lock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_runs_definition_lock ON public.workflow_runs USING btree (workflow_id, status, updated_at DESC) WHERE (workflow_id IS NOT NULL);


--
-- Name: idx_workflow_runs_execution_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_runs_execution_lease ON public.workflow_runs USING btree (execution_lease_id) WHERE (execution_lease_id IS NOT NULL);


--
-- Name: idx_workflow_runs_pending_terminal_notification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_runs_pending_terminal_notification ON public.workflow_runs USING btree (updated_at, id) WHERE (((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying])::text[])) AND (terminal_notification_sent_at IS NULL) AND (terminal_notification_skipped_at IS NULL));


--
-- Name: idx_workflow_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_runs_status ON public.workflow_runs USING btree (status, updated_at, id);


--
-- Name: idx_workflow_runs_user_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_runs_user_updated ON public.workflow_runs USING btree (user_id, updated_at DESC, id DESC);


--
-- Name: administrator_audit_log administrator_audit_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER administrator_audit_no_truncate BEFORE TRUNCATE ON public.administrator_audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_administrator_audit_mutation();


--
-- Name: administrator_audit_log administrator_audit_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER administrator_audit_no_update BEFORE DELETE OR UPDATE ON public.administrator_audit_log FOR EACH ROW EXECUTE FUNCTION public.prevent_administrator_audit_mutation();


--
-- Name: agent_plan_runs agent_plan_runs_active_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plan_runs
    ADD CONSTRAINT agent_plan_runs_active_job_id_fkey FOREIGN KEY (active_job_id) REFERENCES public.persistent_jobs(id);


--
-- Name: agent_plan_steps agent_plan_steps_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_plan_steps
    ADD CONSTRAINT agent_plan_steps_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_plan_runs(id) ON DELETE CASCADE;


--
-- Name: agent_tool_audit_events agent_tool_audit_events_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_audit_events
    ADD CONSTRAINT agent_tool_audit_events_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.agent_approval_credentials(id);


--
-- Name: canvas_agent_conversations canvas_agent_conversations_canvas_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_conversations
    ADD CONSTRAINT canvas_agent_conversations_canvas_id_fkey FOREIGN KEY (canvas_id) REFERENCES public.canvases(id) ON DELETE CASCADE;


--
-- Name: canvas_agent_events canvas_agent_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_events
    ADD CONSTRAINT canvas_agent_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.canvas_agent_runs(id) ON DELETE CASCADE;


--
-- Name: canvas_agent_runs canvas_agent_runs_active_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_runs
    ADD CONSTRAINT canvas_agent_runs_active_job_id_fkey FOREIGN KEY (active_job_id) REFERENCES public.persistent_jobs(id);


--
-- Name: canvas_agent_runs canvas_agent_runs_canvas_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_runs
    ADD CONSTRAINT canvas_agent_runs_canvas_id_fkey FOREIGN KEY (canvas_id) REFERENCES public.canvases(id) ON DELETE CASCADE;


--
-- Name: canvas_agent_runs canvas_agent_runs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_runs
    ADD CONSTRAINT canvas_agent_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.canvas_agent_conversations(id) ON DELETE CASCADE;


--
-- Name: canvas_agent_steps canvas_agent_steps_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_agent_steps
    ADD CONSTRAINT canvas_agent_steps_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.canvas_agent_runs(id) ON DELETE CASCADE;


--
-- Name: canvas_revisions canvas_revisions_canvas_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_revisions
    ADD CONSTRAINT canvas_revisions_canvas_id_fkey FOREIGN KEY (canvas_id) REFERENCES public.canvases(id) ON DELETE CASCADE;


--
-- Name: canvas_workflow_versions canvas_workflow_versions_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_workflow_versions
    ADD CONSTRAINT canvas_workflow_versions_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.canvas_workflows(id) ON DELETE CASCADE;


--
-- Name: canvas_workflows canvas_workflows_canvas_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_workflows
    ADD CONSTRAINT canvas_workflows_canvas_id_fkey FOREIGN KEY (canvas_id) REFERENCES public.canvases(id) ON DELETE CASCADE;


--
-- Name: community_creation_favorites community_creation_favorites_creation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_favorites
    ADD CONSTRAINT community_creation_favorites_creation_id_fkey FOREIGN KEY (creation_id) REFERENCES public.creations(id) ON DELETE CASCADE;


--
-- Name: community_creation_likes community_creation_likes_creation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_likes
    ADD CONSTRAINT community_creation_likes_creation_id_fkey FOREIGN KEY (creation_id) REFERENCES public.creations(id) ON DELETE CASCADE;


--
-- Name: community_creation_reports community_creation_reports_creation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_creation_reports
    ADD CONSTRAINT community_creation_reports_creation_id_fkey FOREIGN KEY (creation_id) REFERENCES public.creations(id) ON DELETE CASCADE;


--
-- Name: content_restore_requests content_restore_requests_recycle_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_restore_requests
    ADD CONSTRAINT content_restore_requests_recycle_entry_id_fkey FOREIGN KEY (recycle_entry_id) REFERENCES public.content_recycle_entries(id);


--
-- Name: invitation_redemptions invitation_redemptions_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation_redemptions
    ADD CONSTRAINT invitation_redemptions_code_id_fkey FOREIGN KEY (code_id) REFERENCES public.invitation_codes(id);


--
-- Name: mcp_call_audit mcp_call_audit_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_call_audit
    ADD CONSTRAINT mcp_call_audit_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.mcp_connections(id) ON DELETE SET NULL;


--
-- Name: mcp_call_audit mcp_call_audit_mcp_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_call_audit
    ADD CONSTRAINT mcp_call_audit_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;


--
-- Name: mcp_connections mcp_connections_mcp_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_transactions mcp_oauth_transactions_mcp_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_transactions
    ADD CONSTRAINT mcp_oauth_transactions_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;


--
-- Name: mcp_server_tools mcp_server_tools_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_server_tools
    ADD CONSTRAINT mcp_server_tools_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;


--
-- Name: model_routes model_routes_model_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_routes
    ADD CONSTRAINT model_routes_model_key_fkey FOREIGN KEY (model_key) REFERENCES public.model_catalog(model_key);


--
-- Name: oauth_client_registrations oauth_client_registrations_mcp_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_client_registrations
    ADD CONSTRAINT oauth_client_registrations_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;


--
-- Name: point_package_refunds point_package_refunds_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_package_refunds
    ADD CONSTRAINT point_package_refunds_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.point_orders(id);


--
-- Name: workflow_events workflow_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events
    ADD CONSTRAINT workflow_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: workflow_loop_iterations workflow_loop_iterations_child_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_loop_iterations
    ADD CONSTRAINT workflow_loop_iterations_child_run_id_fkey FOREIGN KEY (child_run_id) REFERENCES public.workflow_runs(id);


--
-- Name: workflow_loop_iterations workflow_loop_iterations_parent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_loop_iterations
    ADD CONSTRAINT workflow_loop_iterations_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: workflow_nodes workflow_nodes_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_nodes
    ADD CONSTRAINT workflow_nodes_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: workflow_runs workflow_runs_execution_lease_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_execution_lease_id_fkey FOREIGN KEY (execution_lease_id) REFERENCES public.execution_governor_leases(id);


--
-- Name: workflow_runs workflow_runs_parent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.workflow_runs(id);


--
-- Name: workflow_runs workflow_runs_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.canvas_workflows(id);


--
-- PostgreSQL database dump complete
--

\unrestrict uXTAhMI4E1TIe0g6OcZ944D4IxHvOCrMWOkvYCdHiWjZcahPHnv3ao4Ekm89BGY

